"""Source document registry — CRUD, PDF upload, and PDF download.

Design notes:
- document_id is auto-generated as DOC-NNN (sequential, like requirement IDs).
- PDFs are stored in MinIO under the "documents" bucket using the document_id
  as the object key (e.g., "DOC-001.pdf").
- Text extraction runs synchronously on upload using pdfplumber.  For very
  large PDFs this could be made async, but it's fine for Phase 1.
- The download endpoint streams the file back from MinIO so we never buffer
  the entire PDF in API memory.
"""
from __future__ import annotations

import io
import os
from datetime import datetime
from typing import Any
from uuid import UUID

import pdfplumber
from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from fastapi.responses import StreamingResponse
from minio import Minio
from minio.error import S3Error
from sqlalchemy.orm import Session

from database import get_db
from models import Requirement, SourceDocument
from schemas import SourceDocumentCreate, SourceDocumentUpdate

router = APIRouter()

BUCKET = "documents"


# ---------------------------------------------------------------------------
# MinIO client (created once per process)
# ---------------------------------------------------------------------------

def _minio_client() -> Minio:
    endpoint = os.environ.get("MINIO_ENDPOINT", "minio:9000")
    access_key = os.environ.get("MINIO_ACCESS_KEY", "minioadmin")
    secret_key = os.environ.get("MINIO_SECRET_KEY", "minioadmin")
    return Minio(endpoint, access_key=access_key, secret_key=secret_key, secure=False)


def ensure_bucket() -> None:
    """Create the documents bucket if it doesn't already exist.
    Called once at API startup from main.py.
    """
    client = _minio_client()
    if not client.bucket_exists(BUCKET):
        client.make_bucket(BUCKET)


# ---------------------------------------------------------------------------
# Serialisation helper
# ---------------------------------------------------------------------------

def _doc_to_dict(doc: SourceDocument, include_text: bool = False) -> dict[str, Any]:
    d: dict[str, Any] = {
        "id": str(doc.id),
        "document_id": doc.document_id,
        "title": doc.title,
        "document_type": doc.document_type,
        "revision": doc.revision,
        "issuing_organization": doc.issuing_organization,
        "disciplines": doc.disciplines or [],
        "has_file": doc.file_path is not None,
        "created_at": doc.created_at.isoformat(),
        "updated_at": doc.updated_at.isoformat(),
    }
    if include_text:
        d["extracted_text"] = doc.extracted_text
    return d


# ---------------------------------------------------------------------------
# document_id generator
# ---------------------------------------------------------------------------

def _generate_document_id(db: Session) -> str:
    count = db.query(SourceDocument).count()
    return f"DOC-{str(count + 1).zfill(3)}"


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@router.get("/source-documents")
def list_source_documents(db: Session = Depends(get_db)):
    docs = db.query(SourceDocument).order_by(SourceDocument.document_id).all()
    return [_doc_to_dict(d) for d in docs]


@router.get("/source-documents/{doc_id}")
def get_source_document(doc_id: UUID, db: Session = Depends(get_db)):
    doc = db.get(SourceDocument, doc_id)
    if not doc:
        raise HTTPException(status_code=404, detail="Source document not found")

    result = _doc_to_dict(doc, include_text=True)

    # Include the list of requirements derived from this document
    linked_reqs = (
        db.query(Requirement)
        .filter(Requirement.source_document_id == doc_id)
        .order_by(Requirement.requirement_id)
        .all()
    )
    result["linked_requirements"] = [
        {
            "id": str(r.id),
            "requirement_id": r.requirement_id,
            "title": r.title,
            "status": r.status,
            "source_clause": r.source_clause,
        }
        for r in linked_reqs
    ]

    return result


@router.post("/source-documents", status_code=201)
def create_source_document(data: SourceDocumentCreate, db: Session = Depends(get_db)):
    doc_id = _generate_document_id(db)
    doc = SourceDocument(
        document_id=doc_id,
        title=data.title,
        document_type=data.document_type,
        revision=data.revision,
        issuing_organization=data.issuing_organization,
        disciplines=data.disciplines,
    )
    db.add(doc)
    db.commit()
    db.refresh(doc)
    return _doc_to_dict(doc, include_text=True)


@router.put("/source-documents/{doc_id}")
def update_source_document(
    doc_id: UUID, data: SourceDocumentUpdate, db: Session = Depends(get_db)
):
    doc = db.get(SourceDocument, doc_id)
    if not doc:
        raise HTTPException(status_code=404, detail="Source document not found")

    for field, value in data.model_dump(exclude_unset=True).items():
        setattr(doc, field, value)
    doc.updated_at = datetime.utcnow()
    db.commit()
    db.refresh(doc)
    return _doc_to_dict(doc, include_text=True)


@router.post("/source-documents/{doc_id}/upload")
async def upload_pdf(
    doc_id: UUID,
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
):
    """Upload a PDF to MinIO and extract its text.

    The file is read into memory, uploaded to MinIO, then passed to
    pdfplumber for text extraction.  Both operations use the same bytes
    buffer so we only read the file once.

    FastAPI's UploadFile wraps the multipart upload — think of it as the
    HTTP equivalent of a file handle that arrives over the wire.
    """
    doc = db.get(SourceDocument, doc_id)
    if not doc:
        raise HTTPException(status_code=404, detail="Source document not found")

    if not file.filename or not file.filename.lower().endswith(".pdf"):
        raise HTTPException(status_code=400, detail="Only PDF files are accepted")

    pdf_bytes = await file.read()
    object_key = f"{doc.document_id}.pdf"

    # Upload to MinIO
    client = _minio_client()
    try:
        client.put_object(
            BUCKET,
            object_key,
            io.BytesIO(pdf_bytes),
            length=len(pdf_bytes),
            content_type="application/pdf",
        )
    except S3Error as e:
        raise HTTPException(status_code=500, detail=f"MinIO upload failed: {e}")

    # Extract text with pdfplumber
    extracted = ""
    try:
        with pdfplumber.open(io.BytesIO(pdf_bytes)) as pdf:
            pages = [page.extract_text() or "" for page in pdf.pages]
            extracted = "\n\n".join(p for p in pages if p.strip())
    except Exception:
        # Text extraction is best-effort — don't fail the upload
        extracted = ""

    doc.file_path = object_key
    doc.extracted_text = extracted
    doc.updated_at = datetime.utcnow()
    db.commit()
    db.refresh(doc)
    return _doc_to_dict(doc, include_text=True)


@router.get("/source-documents/{doc_id}/download")
def download_pdf(doc_id: UUID, db: Session = Depends(get_db)):
    """Stream the PDF from MinIO back to the browser.

    StreamingResponse avoids loading the entire file into memory — it
    sends the bytes to the client as they arrive from MinIO, similar to
    piping a file through a network connection.
    """
    doc = db.get(SourceDocument, doc_id)
    if not doc:
        raise HTTPException(status_code=404, detail="Source document not found")
    if not doc.file_path:
        raise HTTPException(status_code=404, detail="No file uploaded for this document")

    client = _minio_client()
    try:
        response = client.get_object(BUCKET, doc.file_path)
    except S3Error as e:
        raise HTTPException(status_code=500, detail=f"MinIO download failed: {e}")

    return StreamingResponse(
        response,
        media_type="application/pdf",
        headers={
            "Content-Disposition": f'inline; filename="{doc.document_id}.pdf"'
        },
    )
