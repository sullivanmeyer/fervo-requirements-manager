"""Conflict record tracking — flag contradictions between requirements.

Endpoints
---------
POST   /api/conflict-records                 create a conflict record
GET    /api/conflict-records                 list all (filterable by status)
GET    /api/conflict-records/{id}            single record with linked requirements
PUT    /api/conflict-records/{id}            update status / description / notes
DELETE /api/conflict-records/{id}            soft-delete (archived = true)
"""
from __future__ import annotations

import uuid as uuid_module
from datetime import datetime
from typing import Any, List, Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy.orm import Session

from database import get_db
from models import ConflictRecord, Requirement, conflict_record_requirements

router = APIRouter()

VALID_STATUSES = {"Open", "Under Discussion", "Resolved", "Deferred"}


# ---------------------------------------------------------------------------
# Pydantic schemas
# ---------------------------------------------------------------------------

class ConflictRecordCreate(BaseModel):
    description: str
    requirement_ids: List[str]   # must contain at least 2 requirement UUIDs
    created_by: str


class ConflictRecordUpdate(BaseModel):
    description: Optional[str] = None
    status: Optional[str] = None
    resolution_notes: Optional[str] = None


# ---------------------------------------------------------------------------
# Serialisation helper
# ---------------------------------------------------------------------------

def _conflict_to_dict(cr: ConflictRecord, include_reqs: bool = True) -> dict[str, Any]:
    d: dict[str, Any] = {
        "id": str(cr.id),
        "description": cr.description,
        "status": cr.status,
        "resolution_notes": cr.resolution_notes,
        "created_by": cr.created_by,
        "created_at": cr.created_at.isoformat(),
        "updated_at": cr.updated_at.isoformat(),
    }
    if include_reqs:
        d["requirements"] = [
            {
                "id": str(r.id),
                "requirement_id": r.requirement_id,
                "title": r.title,
                "status": r.status,
            }
            for r in cr.requirements
        ]
    return d


# ---------------------------------------------------------------------------
# POST /conflict-records — create
# ---------------------------------------------------------------------------

@router.post("/conflict-records", status_code=201)
def create_conflict_record(data: ConflictRecordCreate, db: Session = Depends(get_db)):
    if len(data.requirement_ids) < 2:
        raise HTTPException(
            status_code=400,
            detail="A conflict record must link at least 2 requirements.",
        )

    reqs = (
        db.query(Requirement)
        .filter(Requirement.id.in_(data.requirement_ids))
        .all()
    )
    if len(reqs) != len(data.requirement_ids):
        raise HTTPException(status_code=400, detail="One or more requirement_ids not found.")

    cr = ConflictRecord(
        id=uuid_module.uuid4(),
        description=data.description,
        status="Open",
        created_by=data.created_by,
        created_at=datetime.utcnow(),
        updated_at=datetime.utcnow(),
    )
    cr.requirements = reqs
    db.add(cr)
    db.commit()
    db.refresh(cr)
    return _conflict_to_dict(cr)


# ---------------------------------------------------------------------------
# GET /conflict-records — list (filterable by status)
# ---------------------------------------------------------------------------

@router.get("/conflict-records")
def list_conflict_records(
    status: Optional[str] = Query(None),
    requirement_id: Optional[str] = Query(None),
    db: Session = Depends(get_db),
):
    q = db.query(ConflictRecord).filter(ConflictRecord.archived == False)  # noqa: E712

    if status:
        q = q.filter(ConflictRecord.status == status)

    if requirement_id:
        # Filter to records that involve this specific requirement
        q = q.filter(
            ConflictRecord.requirements.any(Requirement.id == requirement_id)
        )

    records = q.order_by(ConflictRecord.created_at.desc()).all()
    return [_conflict_to_dict(cr) for cr in records]


# ---------------------------------------------------------------------------
# GET /conflict-records/{id} — single record
# ---------------------------------------------------------------------------

@router.get("/conflict-records/{record_id}")
def get_conflict_record(record_id: UUID, db: Session = Depends(get_db)):
    cr = db.get(ConflictRecord, record_id)
    if not cr or cr.archived:
        raise HTTPException(status_code=404, detail="Conflict record not found.")
    return _conflict_to_dict(cr)


# ---------------------------------------------------------------------------
# PUT /conflict-records/{id} — update
# ---------------------------------------------------------------------------

@router.put("/conflict-records/{record_id}")
def update_conflict_record(
    record_id: UUID,
    data: ConflictRecordUpdate,
    db: Session = Depends(get_db),
):
    cr = db.get(ConflictRecord, record_id)
    if not cr or cr.archived:
        raise HTTPException(status_code=404, detail="Conflict record not found.")

    if data.status is not None:
        if data.status not in VALID_STATUSES:
            raise HTTPException(
                status_code=400,
                detail=f"Invalid status. Must be one of: {', '.join(sorted(VALID_STATUSES))}",
            )
        cr.status = data.status

    if data.description is not None:
        cr.description = data.description

    if data.resolution_notes is not None:
        cr.resolution_notes = data.resolution_notes

    cr.updated_at = datetime.utcnow()
    db.commit()
    db.refresh(cr)
    return _conflict_to_dict(cr)


# ---------------------------------------------------------------------------
# DELETE /conflict-records/{id} — soft delete
# ---------------------------------------------------------------------------

@router.delete("/conflict-records/{record_id}", status_code=204)
def delete_conflict_record(record_id: UUID, db: Session = Depends(get_db)):
    cr = db.get(ConflictRecord, record_id)
    if not cr or cr.archived:
        raise HTTPException(status_code=404, detail="Conflict record not found.")
    cr.archived = True
    cr.updated_at = datetime.utcnow()
    db.commit()
