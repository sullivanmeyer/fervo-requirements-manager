from __future__ import annotations

from datetime import datetime
from typing import Any, Optional
from uuid import UUID

from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from database import get_db
from models import ConflictRecord, HierarchyNode, Requirement, RequirementLink, Site, SourceDocument, Unit
from schemas import RequirementCreate, RequirementUpdate

router = APIRouter()

# SELF-000 is a system-seeded record that anchors the derivation tree root.
# It must not be editable or deletable by end users.
SELF_DERIVED_ID = "SELF-000"

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


def _req_stub(r: Requirement) -> dict[str, Any]:
    """Minimal representation used in parent/child link lists."""
    return {"id": str(r.id), "requirement_id": r.requirement_id, "title": r.title}


def _requirement_to_dict(
    req: Requirement,
    detail: bool = False,
    db: Session | None = None,
) -> dict[str, Any]:
    """Serialize a Requirement ORM object to a JSON-friendly dict.

    When detail=True and a db session is provided, the response also
    includes parent_requirements and child_requirements lists — the two
    ends of every traceability link touching this requirement.
    """
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
        parent_reqs: list[dict] = []
        child_reqs: list[dict] = []
        if db is not None:
            parent_links = (
                db.query(RequirementLink)
                .filter(RequirementLink.child_requirement_id == req.id)
                .all()
            )
            for lnk in parent_links:
                parent = db.get(Requirement, lnk.parent_requirement_id)
                if parent:
                    parent_reqs.append(_req_stub(parent))

            child_links = (
                db.query(RequirementLink)
                .filter(RequirementLink.parent_requirement_id == req.id)
                .all()
            )
            for lnk in child_links:
                child = db.get(Requirement, lnk.child_requirement_id)
                if child:
                    child_reqs.append(_req_stub(child))

        source_doc = None
        if req.source_document_id and db is not None:
            sd = db.get(SourceDocument, req.source_document_id)
            if sd:
                source_doc = {
                    "id": str(sd.id),
                    "document_id": sd.document_id,
                    "title": sd.title,
                }

        # Conflict records involving this requirement
        conflict_records: list[dict] = []
        if db is not None:
            crs = (
                db.query(ConflictRecord)
                .filter(
                    ConflictRecord.archived == False,  # noqa: E712
                    ConflictRecord.requirements.any(Requirement.id == req.id),
                )
                .order_by(ConflictRecord.created_at.desc())
                .all()
            )
            for cr in crs:
                conflict_records.append({
                    "id": str(cr.id),
                    "description": cr.description,
                    "status": cr.status,
                    "resolution_notes": cr.resolution_notes,
                    "created_by": cr.created_by,
                    "created_at": cr.created_at.isoformat(),
                    "requirements": [
                        {
                            "id": str(r.id),
                            "requirement_id": r.requirement_id,
                            "title": r.title,
                            "status": r.status,
                        }
                        for r in cr.requirements
                    ],
                })

        base.update(
            {
                "statement": req.statement,
                "source_type": req.source_type,
                "source_document_id": str(req.source_document_id) if req.source_document_id else None,
                "source_document": source_doc,
                "source_clause": req.source_clause,
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
                "parent_requirements": parent_reqs,
                "child_requirements": child_reqs,
                "conflict_records": conflict_records,
            }
        )
    return base


# ---------------------------------------------------------------------------
# System record endpoint
# ---------------------------------------------------------------------------


@router.get("/self-derived")
def get_self_derived(db: Session = Depends(get_db)):
    """
    Return the minimal fields of the SELF-000 record so the frontend can
    use its real UUID when building the derivation tree.
    """
    req = (
        db.query(Requirement)
        .filter(Requirement.requirement_id == SELF_DERIVED_ID)
        .first()
    )
    if not req:
        raise HTTPException(status_code=404, detail="Self-Derived record not found")
    return {"id": str(req.id), "requirement_id": req.requirement_id, "title": req.title}


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


def _collect_descendant_ids(node_id: str, db: Session) -> set[UUID]:
    """Return the UUID of node_id plus all its descendants via BFS."""
    result: set[UUID] = set()
    queue: list[UUID] = [UUID(node_id)]
    while queue:
        current = queue.pop()
        result.add(current)
        children = (
            db.query(HierarchyNode.id)
            .filter(HierarchyNode.parent_id == current)
            .all()
        )
        queue.extend(r.id for r in children)
    return result


@router.get("/requirements")
def list_requirements(
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=200),
    # Filters — all optional; multi-value params accepted as repeated keys
    status: Optional[List[str]] = Query(None),
    classification: Optional[str] = Query(None),
    discipline: Optional[List[str]] = Query(None),
    owner: Optional[str] = Query(None),
    source_type: Optional[str] = Query(None),
    source_document_id: Optional[str] = Query(None),
    hierarchy_node_id: Optional[str] = Query(None),
    include_descendants: bool = Query(False),
    site_id: Optional[List[str]] = Query(None),
    unit_id: Optional[List[str]] = Query(None),
    tags: Optional[List[str]] = Query(None),
    created_date_from: Optional[str] = Query(None),
    created_date_to: Optional[str] = Query(None),
    modified_date_from: Optional[str] = Query(None),
    modified_date_to: Optional[str] = Query(None),
    has_open_conflicts: Optional[bool] = Query(None),
    db: Session = Depends(get_db),
):
    """
    Paginated, filterable list of requirements.
    All filter params are optional and additive (AND logic).
    Multi-value params (status, discipline, site_id, unit_id, tags) are
    passed as repeated query string keys: ?status=Draft&status=Approved
    """
    from datetime import date as date_type
    from sqlalchemy import or_

    base_q = db.query(Requirement).filter(
        Requirement.requirement_id != SELF_DERIVED_ID
    )

    if status:
        base_q = base_q.filter(Requirement.status.in_(status))

    if classification:
        base_q = base_q.filter(Requirement.classification == classification)

    if discipline:
        base_q = base_q.filter(Requirement.discipline.in_(discipline))

    if owner:
        base_q = base_q.filter(Requirement.owner.ilike(f"%{owner}%"))

    if source_type:
        base_q = base_q.filter(Requirement.source_type == source_type)

    if source_document_id:
        base_q = base_q.filter(
            Requirement.source_document_id == source_document_id
        )

    if hierarchy_node_id:
        if include_descendants:
            node_ids = _collect_descendant_ids(hierarchy_node_id, db)
        else:
            node_ids = {UUID(hierarchy_node_id)}
        # Filter requirements that have at least one matching hierarchy node
        base_q = base_q.filter(
            Requirement.hierarchy_nodes.any(HierarchyNode.id.in_(node_ids))
        )

    if site_id:
        base_q = base_q.filter(Requirement.sites.any(Site.id.in_(site_id)))

    if unit_id:
        base_q = base_q.filter(Requirement.units.any(Unit.id.in_(unit_id)))

    if tags:
        # Requirement must have ALL of the requested tags
        from sqlalchemy import cast
        from sqlalchemy.dialects.postgresql import ARRAY, TEXT
        for tag in tags:
            base_q = base_q.filter(Requirement.tags.contains(cast([tag], ARRAY(TEXT))))

    if created_date_from:
        base_q = base_q.filter(Requirement.created_date >= created_date_from)
    if created_date_to:
        base_q = base_q.filter(Requirement.created_date <= created_date_to)
    if modified_date_from:
        base_q = base_q.filter(Requirement.last_modified_date >= modified_date_from)
    if modified_date_to:
        base_q = base_q.filter(Requirement.last_modified_date <= modified_date_to)

    if has_open_conflicts is not None:
        from models import conflict_record_requirements as crr_table
        from sqlalchemy import and_
        open_conflict_req_ids = (
            db.query(crr_table.c.requirement_id)
            .join(
                ConflictRecord,
                and_(
                    ConflictRecord.id == crr_table.c.conflict_record_id,
                    ConflictRecord.archived == False,  # noqa: E712
                    ConflictRecord.status == "Open",
                ),
            )
            .scalar_subquery()
        )
        if has_open_conflicts:
            base_q = base_q.filter(Requirement.id.in_(open_conflict_req_ids))
        else:
            base_q = base_q.filter(~Requirement.id.in_(open_conflict_req_ids))

    offset = (page - 1) * page_size
    total = base_q.count()
    reqs = (
        base_q
        .order_by(Requirement.requirement_id)
        .offset(offset)
        .limit(page_size)
        .all()
    )

    # Attach open conflict count to each list item
    from models import conflict_record_requirements as crr_table
    from sqlalchemy import func, and_

    open_conflict_counts: dict[str, int] = {}
    if reqs:
        req_ids = [r.id for r in reqs]
        rows = (
            db.query(
                crr_table.c.requirement_id,
                func.count(crr_table.c.conflict_record_id).label("cnt"),
            )
            .join(
                ConflictRecord,
                and_(
                    ConflictRecord.id == crr_table.c.conflict_record_id,
                    ConflictRecord.archived == False,  # noqa: E712
                    ConflictRecord.status == "Open",
                ),
            )
            .filter(crr_table.c.requirement_id.in_(req_ids))
            .group_by(crr_table.c.requirement_id)
            .all()
        )
        open_conflict_counts = {str(row[0]): row[1] for row in rows}

    items = []
    for r in reqs:
        d = _requirement_to_dict(r, detail=False)
        d["open_conflict_count"] = open_conflict_counts.get(str(r.id), 0)
        items.append(d)

    return {
        "total": total,
        "page": page,
        "page_size": page_size,
        "items": items,
    }


@router.get("/requirements/{req_id}")
def get_requirement(req_id: UUID, db: Session = Depends(get_db)):
    req = db.get(Requirement, req_id)
    if not req:
        raise HTTPException(status_code=404, detail="Requirement not found")
    return _requirement_to_dict(req, detail=True, db=db)


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
    # Resolve source_document_id UUID → actual FK value (or None)
    if scalar_fields.get("source_document_id") is not None:
        sd = db.get(SourceDocument, scalar_fields["source_document_id"])
        if not sd:
            raise HTTPException(status_code=400, detail="source_document_id not found")
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
    return _requirement_to_dict(req, detail=True, db=db)


@router.put("/requirements/{req_id}")
def update_requirement(
    req_id: UUID, data: RequirementUpdate, db: Session = Depends(get_db)
):
    req = db.get(Requirement, req_id)
    if not req:
        raise HTTPException(status_code=404, detail="Requirement not found")

    if req.requirement_id == SELF_DERIVED_ID:
        raise HTTPException(
            status_code=403,
            detail="The Self-Derived record is read-only and cannot be edited",
        )

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
    return _requirement_to_dict(req, detail=True, db=db)
