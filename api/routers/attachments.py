"""Requirement file attachments — upload, list, download.

Files are stored in MinIO under the "attachments" bucket.
The object key is the attachment UUID to avoid any special characters.
"""
from __future__ import annotations

import io
import os
import uuid as uuid_module
from datetime import datetime
from uuid import UUID

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from fastapi.responses import StreamingResponse
from minio import Minio
from minio.error import S3Error
from sqlalchemy.orm import Session

from database import get_db
from models import Requirement, RequirementAttachment

router = APIRouter()

BUCKET = "attachments"


def _minio_client() -> Minio:
    endpoint = os.environ.get("MINIO_ENDPOINT", "minio:9000")
    access_key = os.environ.get("MINIO_ACCESS_KEY", "minioadmin")
    secret_key = os.environ.get("MINIO_SECRET_KEY", "minioadmin")
    return Minio(endpoint, access_key=access_key, secret_key=secret_key, secure=False)


def ensure_attachments_bucket() -> None:
    """Create the attachments bucket if it doesn't already exist."""
    client = _minio_client()
    if not client.bucket_exists(BUCKET):
        client.make_bucket(BUCKET)


# ---------------------------------------------------------------------------
# List attachments
# ---------------------------------------------------------------------------

@router.get("/requirements/{requirement_id}/attachments")
def list_attachments(requirement_id: UUID, db: Session = Depends(get_db)):
    req = db.query(Requirement).filter(Requirement.id == requirement_id).first()
    if not req:
        raise HTTPException(status_code=404, detail="Requirement not found")

    attachments = (
        db.query(RequirementAttachment)
        .filter(RequirementAttachment.requirement_id == requirement_id)
        .order_by(RequirementAttachment.uploaded_at.asc())
        .all()
    )
    return [
        {
            "id": str(a.id),
            "file_name": a.file_name,
            "file_size": a.file_size,
            "content_type": a.content_type,
            "uploaded_by": a.uploaded_by,
            "uploaded_at": a.uploaded_at.isoformat() if a.uploaded_at else None,
        }
        for a in attachments
    ]


# ---------------------------------------------------------------------------
# Upload attachment
# ---------------------------------------------------------------------------

@router.post("/requirements/{requirement_id}/attachments", status_code=201)
def upload_attachment(
    requirement_id: UUID,
    file: UploadFile = File(...),
    uploaded_by: str = "",
    db: Session = Depends(get_db),
):
    req = db.query(Requirement).filter(Requirement.id == requirement_id).first()
    if not req:
        raise HTTPException(status_code=404, detail="Requirement not found")

    attachment_id = uuid_module.uuid4()
    object_key = str(attachment_id)

    file_data = file.file.read()
    file_size = len(file_data)
    content_type = file.content_type or "application/octet-stream"

    client = _minio_client()
    try:
        client.put_object(
            BUCKET,
            object_key,
            io.BytesIO(file_data),
            length=file_size,
            content_type=content_type,
        )
    except S3Error as e:
        raise HTTPException(status_code=500, detail=f"File storage error: {e}")

    attachment = RequirementAttachment(
        id=attachment_id,
        requirement_id=requirement_id,
        file_name=file.filename or "attachment",
        file_path=object_key,
        file_size=file_size,
        content_type=content_type,
        uploaded_by=uploaded_by or None,
        uploaded_at=datetime.utcnow(),
    )
    db.add(attachment)
    db.commit()
    db.refresh(attachment)

    return {
        "id": str(attachment.id),
        "file_name": attachment.file_name,
        "file_size": attachment.file_size,
        "content_type": attachment.content_type,
        "uploaded_by": attachment.uploaded_by,
        "uploaded_at": attachment.uploaded_at.isoformat(),
    }


# ---------------------------------------------------------------------------
# Download attachment
# ---------------------------------------------------------------------------

@router.get("/attachments/{attachment_id}/download")
def download_attachment(attachment_id: UUID, db: Session = Depends(get_db)):
    attachment = (
        db.query(RequirementAttachment)
        .filter(RequirementAttachment.id == attachment_id)
        .first()
    )
    if not attachment:
        raise HTTPException(status_code=404, detail="Attachment not found")

    client = _minio_client()
    try:
        response = client.get_object(BUCKET, attachment.file_path)
    except S3Error:
        raise HTTPException(status_code=404, detail="File not found in storage")

    return StreamingResponse(
        response,
        media_type=attachment.content_type or "application/octet-stream",
        headers={
            "Content-Disposition": f'attachment; filename="{attachment.file_name}"'
        },
    )


# ---------------------------------------------------------------------------
# Delete attachment
# ---------------------------------------------------------------------------

@router.delete("/attachments/{attachment_id}", status_code=204)
def delete_attachment(attachment_id: UUID, db: Session = Depends(get_db)):
    attachment = (
        db.query(RequirementAttachment)
        .filter(RequirementAttachment.id == attachment_id)
        .first()
    )
    if not attachment:
        raise HTTPException(status_code=404, detail="Attachment not found")

    client = _minio_client()
    try:
        client.remove_object(BUCKET, attachment.file_path)
    except S3Error:
        pass  # If the file is already gone from storage, still delete the record

    db.delete(attachment)
    db.commit()
