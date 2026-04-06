from __future__ import annotations

from datetime import datetime
from typing import Any, Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from database import get_db
from models import HierarchyNode, Requirement, Site, Unit
from schemas import RequirementCreate, RequirementUpdate

router = APIRouter()

# Maps discipline enum value → prefix used in auto-generated requirement_id
DISCIPLINE_PREFIXES: dict[str, str] = {
    "Mechanical": "MECH",
    "Electrical": "ELEC",
    "I&C": "INC",
    "Civil/Structural": "CIVIL",
    "Process": "PROC",
    "Fire Protection": "FP",
    "General": "GEN",
}


def _generate_requirement_id(discipline: str, db: Session) -> str:
    """
    Generate the next sequential requirement_id for a discipline.
    Format: PREFIX-NNN (zero-padded to 3 digits, grows if needed)
    Example: MECH-001, ELEC-017, INC-100
    """
    prefix = DISCIPLINE_PREFIXES.get(discipline, "REQ")
    # Count existing requirements with the same prefix to determine next sequence
    like_pattern = f"{prefix}-%"
    count = (
        db.query(Requirement)
        .filter(Requirement.requirement_id.like(like_pattern))
        .count()
    )
    seq = count + 1
    # Zero-pad to at least 3 digits; expands automatically beyond 999
    padded = str(seq).zfill(3)
    return f"{prefix}-{padded}"


def _requirement_to_dict(req: Requirement, detail: bool = False) -> dict[str, Any]:
    """Serialize a Requirement ORM object to a JSON-friendly dict."""
    base = {
        "id": str(req.id),
        "requirement_id": req.requirement_id,
        "title": req.title,
        "classification": req.classification,
        "owner": req.owner,
        "status": req.status,
        "discipline": req.discipline,
        "created_by": req.created_by,
        "created_date": req.created_date.isoformat() if req.created_date else None,
        "hierarchy_nodes": [
            {"id": str(n.id), "name": n.name} for n in req.hierarchy_nodes
        ],
        "sites": [{"id": str(s.id), "name": s.name} for s in req.sites],
        "units": [{"id": str(u.id), "name": u.name} for u in req.units],
    }
    if detail:
        base.update(
            {
                "statement": req.statement,
                "source_type": req.source_type,
                "last_modified_by": req.last_modified_by,
                "last_modified_date": (
                    req.last_modified_date.isoformat()
                    if req.last_modified_date
                    else None
                ),
                "change_history": req.change_history,
                "rationale": req.rationale,
                "verification_method": req.verification_method,
                "tags": req.tags or [],
                "created_at": req.created_at.isoformat(),
                "updated_at": req.updated_at.isoformat(),
            }
        )
    return base


# ---------------------------------------------------------------------------
# Reference data endpoints
# ---------------------------------------------------------------------------


@router.get("/sites")
def list_sites(db: Session = Depends(get_db)):
    sites = db.query(Site).order_by(Site.name).all()
    return [{"id": str(s.id), "name": s.name} for s in sites]


@router.get("/units")
def list_units(db: Session = Depends(get_db)):
    units = db.query(Unit).order_by(Unit.sort_order, Unit.name).all()
    return [{"id": str(u.id), "name": u.name, "sort_order": u.sort_order} for u in units]


# ---------------------------------------------------------------------------
# Requirement CRUD
# ---------------------------------------------------------------------------


@router.get("/requirements")
def list_requirements(
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=200),
    db: Session = Depends(get_db),
):
    """
    Paginated list of requirements — lightweight records for the table view.
    Returns total count alongside the page of items so the frontend can
    render a page indicator without a second request.
    """
    offset = (page - 1) * page_size
    total = db.query(Requirement).count()
    reqs = (
        db.query(Requirement)
        .order_by(Requirement.requirement_id)
        .offset(offset)
        .limit(page_size)
        .all()
    )
    return {
        "total": total,
        "page": page,
        "page_size": page_size,
        "items": [_requirement_to_dict(r, detail=False) for r in reqs],
    }


@router.get("/requirements/{req_id}")
def get_requirement(req_id: UUID, db: Session = Depends(get_db)):
    req = db.get(Requirement, req_id)
    if not req:
        raise HTTPException(status_code=404, detail="Requirement not found")
    return _requirement_to_dict(req, detail=True)


@router.post("/requirements", status_code=201)
def create_requirement(data: RequirementCreate, db: Session = Depends(get_db)):
    # Pull out the relationship IDs before building the ORM object
    hierarchy_node_ids = data.hierarchy_node_ids
    site_ids = data.site_ids
    unit_ids = data.unit_ids

    # Build the requirement from scalar fields only
    scalar_fields = data.model_dump(
        exclude={"hierarchy_node_ids", "site_ids", "unit_ids"}
    )
    req_id = _generate_requirement_id(data.discipline, db)

    req = Requirement(requirement_id=req_id, **scalar_fields)

    # Resolve and attach hierarchy nodes
    if hierarchy_node_ids:
        nodes = (
            db.query(HierarchyNode)
            .filter(HierarchyNode.id.in_(hierarchy_node_ids))
            .all()
        )
        if len(nodes) != len(hierarchy_node_ids):
            raise HTTPException(
                status_code=400, detail="One or more hierarchy_node_ids not found"
            )
        req.hierarchy_nodes = nodes

    # Resolve and attach sites
    if site_ids:
        sites = db.query(Site).filter(Site.id.in_(site_ids)).all()
        if len(sites) != len(site_ids):
            raise HTTPException(status_code=400, detail="One or more site_ids not found")
        req.sites = sites

    # Resolve and attach units
    if unit_ids:
        units = db.query(Unit).filter(Unit.id.in_(unit_ids)).all()
        if len(units) != len(unit_ids):
            raise HTTPException(status_code=400, detail="One or more unit_ids not found")
        req.units = units

    db.add(req)
    db.commit()
    db.refresh(req)
    return _requirement_to_dict(req, detail=True)


@router.put("/requirements/{req_id}")
def update_requirement(
    req_id: UUID, data: RequirementUpdate, db: Session = Depends(get_db)
):
    req = db.get(Requirement, req_id)
    if not req:
        raise HTTPException(status_code=404, detail="Requirement not found")

    # Update scalar fields (exclude relationship ID lists)
    scalar_fields = data.model_dump(
        exclude_unset=True,
        exclude={"hierarchy_node_ids", "site_ids", "unit_ids"},
    )
    for field, value in scalar_fields.items():
        setattr(req, field, value)

    # Replace relationships only when the caller explicitly provided them
    if data.hierarchy_node_ids is not None:
        nodes = (
            db.query(HierarchyNode)
            .filter(HierarchyNode.id.in_(data.hierarchy_node_ids))
            .all()
        )
        if len(nodes) != len(data.hierarchy_node_ids):
            raise HTTPException(
                status_code=400, detail="One or more hierarchy_node_ids not found"
            )
        req.hierarchy_nodes = nodes

    if data.site_ids is not None:
        sites = db.query(Site).filter(Site.id.in_(data.site_ids)).all()
        if len(sites) != len(data.site_ids):
            raise HTTPException(status_code=400, detail="One or more site_ids not found")
        req.sites = sites

    if data.unit_ids is not None:
        units = db.query(Unit).filter(Unit.id.in_(data.unit_ids)).all()
        if len(units) != len(data.unit_ids):
            raise HTTPException(status_code=400, detail="One or more unit_ids not found")
        req.units = units

    req.updated_at = datetime.utcnow()
    db.commit()
    db.refresh(req)
    return _requirement_to_dict(req, detail=True)
