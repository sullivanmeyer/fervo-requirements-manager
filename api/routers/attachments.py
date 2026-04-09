"""Requirement file attachments — upload, list, download.

Files are stored in the "attachments" bucket (MinIO locally, Azure Blob in prod).
The object key is the attachment UUID to avoid any special characters.
"""
from __future__ import annotations

import uuid as uuid_module
from datetime import datetime
from uuid import UUID

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session

from database import get_db
from models import Requirement, RequirementAttachment
from storage import StorageError, delete_file, download_file, ensure_bucket as _ensure_bucket, upload_file

router = APIRouter()

BUCKET = "attachments"


def ensure_attachments_bucket() -> None:
    """Create the attachments bucket / container if it doesn't exist."""
    _ensure_bucket(BUCKET)


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

    try:
        upload_file(BUCKET, object_key, file_data, content_type)
    except StorageError as e:
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

    try:
        stream = download_file(BUCKET, attachment.file_path)
    except StorageError:
        raise HTTPException(status_code=404, detail="File not found in storage")

    return StreamingResponse(
        stream,
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

    delete_file(BUCKET, attachment.file_path)  # silently ignores missing files

    db.delete(attachment)
    db.commit()
