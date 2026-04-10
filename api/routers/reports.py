from __future__ import annotations

from typing import Any
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from database import get_db
from models import (
    HierarchyNode,
    Requirement,
    RequirementLink,
    requirement_hierarchy_nodes,
)

router = APIRouter()

SELF_DERIVED_ID = "SELF-000"


def _req_stub(r: Requirement) -> dict[str, Any]:
    return {
        "id": str(r.id),
        "requirement_id": r.requirement_id,
        "title": r.title,
        "discipline": r.discipline,
        "status": r.status,
        "owner": r.owner,
        "hierarchy_nodes": [{"id": str(n.id), "name": n.name} for n in r.hierarchy_nodes],
    }


def _node_stub(n: HierarchyNode) -> dict[str, Any]:
    return {
        "id": str(n.id),
        "name": n.name,
        "applicable_disciplines": n.applicable_disciplines or [],
        "parent_id": str(n.parent_id) if n.parent_id else None,
    }


# ---------------------------------------------------------------------------
# Orphan report
# ---------------------------------------------------------------------------

@router.get("/reports/orphans")
def get_orphans(
    discipline: str | None = Query(None),
    status: str | None = Query(None),
    db: Session = Depends(get_db),
):
    """
    Requirements whose only traceability parent is Self-Derived AND that are
    assigned to at least one non-root hierarchy node.

    These are candidates for missing flow-down: a component-level requirement
    that has no real upstream source is probably underspecified.
    """
    self_derived = (
        db.query(Requirement)
        .filter(Requirement.requirement_id == SELF_DERIVED_ID)
        .first()
    )
    if not self_derived:
        return []

    # IDs of requirements that have at least one real parent (not Self-Derived)
    has_real_parent_subq = (
        db.query(RequirementLink.child_requirement_id)
        .filter(RequirementLink.parent_requirement_id != self_derived.id)
        .subquery()
    )

    base_q = (
        db.query(Requirement)
        .filter(Requirement.requirement_id != SELF_DERIVED_ID)
        .filter(~Requirement.id.in_(has_real_parent_subq))
        # Must be assigned to at least one hierarchy node
        .filter(Requirement.hierarchy_nodes.any())
    )

    if discipline:
        base_q = base_q.filter(Requirement.discipline == discipline)
    if status:
        base_q = base_q.filter(Requirement.status == status)
    else:
        # Exclude terminal statuses by default — they're intentionally closed
        base_q = base_q.filter(Requirement.status.notin_(["Withdrawn", "Superseded"]))

    orphans = base_q.order_by(Requirement.requirement_id).all()
    return [_req_stub(r) for r in orphans]


# ---------------------------------------------------------------------------
# Gap analysis
# ---------------------------------------------------------------------------

@router.get("/reports/gaps")
def get_gaps(
    requirement_id: UUID = Query(...),
    db: Session = Depends(get_db),
):
    """
    For a given parent requirement, return the hierarchy nodes that are
    discipline-compatible but have no child requirements derived from it.

    Discipline compatibility:
      - A node with applicable_disciplines = [] / NULL matches every discipline.
      - A node with applicable_disciplines set matches only if the requirement's
        discipline is in that list.

    A node is "covered" if at least one direct child of the requirement is
    assigned to that node.  All other compatible nodes are "gaps".
    """
    req = db.get(Requirement, requirement_id)
    if not req:
        raise HTTPException(status_code=404, detail="Requirement not found")

    # IDs of direct child requirements
    child_req_ids = [
        link.child_requirement_id
        for link in db.query(RequirementLink)
        .filter(RequirementLink.parent_requirement_id == req.id)
        .all()
    ]

    # Hierarchy node IDs that are already covered by child requirements
    covered_node_ids: set[str] = set()
    if child_req_ids:
        rows = (
            db.query(requirement_hierarchy_nodes.c.hierarchy_node_id)
            .filter(requirement_hierarchy_nodes.c.requirement_id.in_(child_req_ids))
            .all()
        )
        covered_node_ids = {str(row[0]) for row in rows}

    # All non-archived hierarchy nodes — filter by discipline compatibility
    all_nodes = (
        db.query(HierarchyNode)
        .filter(HierarchyNode.archived == False)  # noqa: E712
        .order_by(HierarchyNode.name)
        .all()
    )

    req_discipline = req.discipline
    relevant_nodes = [
        n for n in all_nodes
        if not (n.applicable_disciplines or [])  # null/empty = universal
        or req_discipline in (n.applicable_disciplines or [])
    ]

    covered = [n for n in relevant_nodes if str(n.id) in covered_node_ids]
    gaps = [n for n in relevant_nodes if str(n.id) not in covered_node_ids]

    return {
        "requirement": _req_stub(req),
        "covered": [_node_stub(n) for n in covered],
        "gaps": [_node_stub(n) for n in gaps],
    }
