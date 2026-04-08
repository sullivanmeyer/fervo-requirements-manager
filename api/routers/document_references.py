"""Document reference graph — inter-document dependency tracking.

Design notes:
- A "document reference" is a directed edge: source_document → referenced_document.
  Reading it: "source_document cites / depends on referenced_document."
- Edges can be added manually by users or (in future) extracted automatically
  by the LLM decomposition pipeline.
- The graph endpoint returns all nodes + edges in a single call so the frontend
  can build the full network without N+1 fetches.
"""
from __future__ import annotations

import uuid
from datetime import datetime
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from database import get_db
from models import DocumentReference, SourceDocument

router = APIRouter()


# ---------------------------------------------------------------------------
# Pydantic schemas
# ---------------------------------------------------------------------------

class DocumentReferenceCreate(BaseModel):
    source_document_id: str
    referenced_document_id: str
    reference_context: Optional[str] = None


class DocumentReferenceOut(BaseModel):
    id: str
    source_document_id: str
    referenced_document_id: str
    reference_context: Optional[str]
    created_at: str

    class Config:
        from_attributes = True


class GraphNode(BaseModel):
    id: str
    document_id: str
    title: str
    document_type: str
    issuing_organization: Optional[str]
    revision: Optional[str]
    disciplines: list[str]
    out_count: int     # how many documents this one cites
    in_count: int      # how many documents cite this one
    is_stub: bool      # auto-detected reference; not yet fully registered


class GraphEdge(BaseModel):
    id: str
    source_id: str
    target_id: str
    reference_context: Optional[str]


class DocumentGraphResponse(BaseModel):
    nodes: list[GraphNode]
    edges: list[GraphEdge]


class DocumentReferenceListItem(BaseModel):
    id: str
    document_id: str        # the other document's human-readable ID
    title: str
    document_type: str
    reference_context: Optional[str]
    ref_row_id: str          # the document_references PK for deletion


# ---------------------------------------------------------------------------
# Helper
# ---------------------------------------------------------------------------

def _ref_to_out(ref: DocumentReference) -> DocumentReferenceOut:
    return DocumentReferenceOut(
        id=str(ref.id),
        source_document_id=str(ref.source_document_id),
        referenced_document_id=str(ref.referenced_document_id),
        reference_context=ref.reference_context,
        created_at=ref.created_at.isoformat(),
    )


# ---------------------------------------------------------------------------
# GET /document-references/graph
# ---------------------------------------------------------------------------

@router.get("/document-references/graph", response_model=DocumentGraphResponse)
def get_graph(db: Session = Depends(get_db)):
    """Return every source document as a node and every reference as an edge."""
    docs = db.query(SourceDocument).all()
    refs = db.query(DocumentReference).all()

    # Build connection count maps
    out_counts: dict[str, int] = {}
    in_counts: dict[str, int] = {}
    for ref in refs:
        src = str(ref.source_document_id)
        tgt = str(ref.referenced_document_id)
        out_counts[src] = out_counts.get(src, 0) + 1
        in_counts[tgt] = in_counts.get(tgt, 0) + 1

    nodes = [
        GraphNode(
            id=str(doc.id),
            document_id=doc.document_id,
            title=doc.title,
            document_type=doc.document_type,
            issuing_organization=doc.issuing_organization,
            revision=doc.revision,
            disciplines=doc.disciplines or [],
            out_count=out_counts.get(str(doc.id), 0),
            in_count=in_counts.get(str(doc.id), 0),
            is_stub=bool(doc.is_stub),
        )
        for doc in docs
    ]

    edges = [
        GraphEdge(
            id=str(ref.id),
            source_id=str(ref.source_document_id),
            target_id=str(ref.referenced_document_id),
            reference_context=ref.reference_context,
        )
        for ref in refs
    ]

    return DocumentGraphResponse(nodes=nodes, edges=edges)


# ---------------------------------------------------------------------------
# POST /document-references
# ---------------------------------------------------------------------------

@router.post("/document-references", response_model=DocumentReferenceOut, status_code=201)
def create_reference(payload: DocumentReferenceCreate, db: Session = Depends(get_db)):
    """Manually add a directed reference between two documents."""
    # Validate both documents exist
    src = db.query(SourceDocument).filter(
        SourceDocument.id == payload.source_document_id
    ).first()
    if not src:
        raise HTTPException(status_code=404, detail="Source document not found")

    tgt = db.query(SourceDocument).filter(
        SourceDocument.id == payload.referenced_document_id
    ).first()
    if not tgt:
        raise HTTPException(status_code=404, detail="Referenced document not found")

    if payload.source_document_id == payload.referenced_document_id:
        raise HTTPException(status_code=422, detail="A document cannot reference itself")

    # Check for duplicate
    existing = db.query(DocumentReference).filter(
        DocumentReference.source_document_id == payload.source_document_id,
        DocumentReference.referenced_document_id == payload.referenced_document_id,
    ).first()
    if existing:
        raise HTTPException(
            status_code=409,
            detail="This reference already exists",
        )

    ref = DocumentReference(
        id=uuid.uuid4(),
        source_document_id=uuid.UUID(payload.source_document_id),
        referenced_document_id=uuid.UUID(payload.referenced_document_id),
        reference_context=payload.reference_context,
        created_at=datetime.utcnow(),
    )
    db.add(ref)
    db.commit()
    db.refresh(ref)
    return _ref_to_out(ref)


# ---------------------------------------------------------------------------
# DELETE /document-references/{id}
# ---------------------------------------------------------------------------

@router.delete("/document-references/{ref_id}", status_code=204)
def delete_reference(ref_id: str, db: Session = Depends(get_db)):
    """Remove a document reference by its row ID."""
    ref = db.query(DocumentReference).filter(
        DocumentReference.id == ref_id
    ).first()
    if not ref:
        raise HTTPException(status_code=404, detail="Reference not found")
    db.delete(ref)
    db.commit()


# ---------------------------------------------------------------------------
# GET /source-documents/{id}/references  (outgoing)
# ---------------------------------------------------------------------------

@router.get(
    "/source-documents/{doc_id}/references",
    response_model=list[DocumentReferenceListItem],
)
def get_outgoing_references(doc_id: str, db: Session = Depends(get_db)):
    """Documents that this document cites (outgoing edges)."""
    refs = (
        db.query(DocumentReference)
        .filter(DocumentReference.source_document_id == doc_id)
        .all()
    )
    result = []
    for ref in refs:
        other = db.query(SourceDocument).filter(
            SourceDocument.id == ref.referenced_document_id
        ).first()
        if other:
            result.append(DocumentReferenceListItem(
                id=str(other.id),
                document_id=other.document_id,
                title=other.title,
                document_type=other.document_type,
                reference_context=ref.reference_context,
                ref_row_id=str(ref.id),
            ))
    return result


# ---------------------------------------------------------------------------
# GET /source-documents/{id}/referenced-by  (incoming)
# ---------------------------------------------------------------------------

@router.get(
    "/source-documents/{doc_id}/referenced-by",
    response_model=list[DocumentReferenceListItem],
)
def get_incoming_references(doc_id: str, db: Session = Depends(get_db)):
    """Documents that cite this document (incoming edges)."""
    refs = (
        db.query(DocumentReference)
        .filter(DocumentReference.referenced_document_id == doc_id)
        .all()
    )
    result = []
    for ref in refs:
        other = db.query(SourceDocument).filter(
            SourceDocument.id == ref.source_document_id
        ).first()
        if other:
            result.append(DocumentReferenceListItem(
                id=str(other.id),
                document_id=other.document_id,
                title=other.title,
                document_type=other.document_type,
                reference_context=ref.reference_context,
                ref_row_id=str(ref.id),
            ))
    return result
