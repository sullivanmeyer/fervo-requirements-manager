"""Saved filter configurations for the requirements table."""
from __future__ import annotations

import json
from typing import Any, Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy.orm import Session

from database import get_db
from models import SavedFilter

router = APIRouter()


class SavedFilterCreate(BaseModel):
    name: str
    filter_config: dict
    user_name: Optional[str] = None


def _filter_to_dict(f: SavedFilter) -> dict[str, Any]:
    return {
        "id": str(f.id),
        "name": f.name,
        "filter_config": json.loads(f.filter_config) if isinstance(f.filter_config, str) else f.filter_config,
        "user_name": f.user_name,
        "created_at": f.created_at.isoformat(),
    }


@router.get("/saved-filters")
def list_saved_filters(
    user_name: Optional[str] = Query(None),
    db: Session = Depends(get_db),
):
    q = db.query(SavedFilter).order_by(SavedFilter.name)
    if user_name:
        q = q.filter(SavedFilter.user_name == user_name)
    return [_filter_to_dict(f) for f in q.all()]


@router.post("/saved-filters", status_code=201)
def create_saved_filter(data: SavedFilterCreate, db: Session = Depends(get_db)):
    f = SavedFilter(
        name=data.name,
        filter_config=json.dumps(data.filter_config),
        user_name=data.user_name,
    )
    db.add(f)
    db.commit()
    db.refresh(f)
    return _filter_to_dict(f)


@router.delete("/saved-filters/{filter_id}", status_code=204)
def delete_saved_filter(filter_id: UUID, db: Session = Depends(get_db)):
    f = db.get(SavedFilter, filter_id)
    if not f:
        raise HTTPException(status_code=404, detail="Saved filter not found")
    db.delete(f)
    db.commit()
