from __future__ import annotations

from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from database import get_db
from models import Requirement, RequirementLink
from schemas import RequirementLinkCreate, RequirementLinkDelete

router = APIRouter()

SELF_DERIVED_ID = "SELF-000"


# ---------------------------------------------------------------------------
# Cycle detection
# ---------------------------------------------------------------------------

def _get_all_descendants(req_id: UUID, db: Session) -> set[UUID]:
    """
    Walk the derivation tree downward from req_id and return every
    descendant UUID.  Uses a simple iterative BFS — perfectly fine for
    the graph sizes expected here.

    Think of it like a P&ID trace: starting at one piece of equipment,
    follow every downstream connection until you run out of pipe.
    """
    visited: set[UUID] = set()
    queue: list[UUID] = [req_id]
    while queue:
        current = queue.pop()
        if current in visited:
            continue
        visited.add(current)
        children = (
            db.query(RequirementLink.child_requirement_id)
            .filter(RequirementLink.parent_requirement_id == current)
            .all()
        )
        queue.extend(row[0] for row in children)
    visited.discard(req_id)  # exclude the starting node itself
    return visited


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@router.get("/requirement-links")
def list_links(db: Session = Depends(get_db)):
    """Return every link as a flat list of (parent_id, child_id) pairs.
    The frontend uses this to build the derivation tree client-side."""
    links = db.query(RequirementLink).all()
    return [
        {
            "parent_requirement_id": str(lnk.parent_requirement_id),
            "child_requirement_id": str(lnk.child_requirement_id),
        }
        for lnk in links
    ]


@router.post("/requirement-links", status_code=201)
def add_link(data: RequirementLinkCreate, db: Session = Depends(get_db)):
    """
    Add a parent → child derivation link.

    Validates:
    - Both requirements exist.
    - The link does not already exist.
    - The link would not create a cycle.

    Cycle detection: before inserting A→B, we check whether A is already
    reachable *from* B (i.e., A is a descendant of B).  If it is, adding
    A→B would close a loop, like connecting a pipe's outlet back to its
    own upstream inlet.
    """
    parent = db.get(Requirement, data.parent_requirement_id)
    if not parent:
        raise HTTPException(status_code=404, detail="Parent requirement not found")

    child = db.get(Requirement, data.child_requirement_id)
    if not child:
        raise HTTPException(status_code=404, detail="Child requirement not found")

    # Prevent self-loop (also enforced at DB level, but better to surface a
    # clear error message here)
    if data.parent_requirement_id == data.child_requirement_id:
        raise HTTPException(
            status_code=400, detail="A requirement cannot be its own parent"
        )

    # Prevent duplicate
    existing = db.get(
        RequirementLink,
        (data.parent_requirement_id, data.child_requirement_id),
    )
    if existing:
        raise HTTPException(status_code=409, detail="This link already exists")

    # Cycle detection: descendants of the proposed child must not include
    # the proposed parent
    descendants_of_child = _get_all_descendants(data.child_requirement_id, db)
    if data.parent_requirement_id in descendants_of_child:
        raise HTTPException(
            status_code=400,
            detail=(
                f"Adding this link would create a cycle: "
                f"{child.requirement_id} is already an ancestor of "
                f"{parent.requirement_id}"
            ),
        )

    link = RequirementLink(
        parent_requirement_id=data.parent_requirement_id,
        child_requirement_id=data.child_requirement_id,
    )
    db.add(link)
    db.commit()
    return {
        "parent_requirement_id": str(link.parent_requirement_id),
        "child_requirement_id": str(link.child_requirement_id),
    }


@router.delete("/requirement-links", status_code=200)
def remove_link(data: RequirementLinkDelete, db: Session = Depends(get_db)):
    link = db.get(
        RequirementLink,
        (data.parent_requirement_id, data.child_requirement_id),
    )
    if not link:
        raise HTTPException(status_code=404, detail="Link not found")
    db.delete(link)
    db.commit()
    return {"detail": "Link removed"}


@router.get("/requirements/{req_id}/ancestors")
def get_ancestors(req_id: UUID, db: Session = Depends(get_db)):
    """
    Walk upward from req_id to the root of the derivation tree, returning
    every ancestor in breadth-first order.
    """
    req = db.get(Requirement, req_id)
    if not req:
        raise HTTPException(status_code=404, detail="Requirement not found")

    visited: set[UUID] = set()
    queue: list[UUID] = [req_id]
    result = []

    while queue:
        current = queue.pop(0)
        if current in visited:
            continue
        visited.add(current)
        parents = (
            db.query(RequirementLink.parent_requirement_id)
            .filter(RequirementLink.child_requirement_id == current)
            .all()
        )
        for (pid,) in parents:
            if pid not in visited:
                parent_req = db.get(Requirement, pid)
                if parent_req:
                    result.append({
                        "id": str(parent_req.id),
                        "requirement_id": parent_req.requirement_id,
                        "title": parent_req.title,
                    })
                queue.append(pid)

    return result


@router.get("/requirements/{req_id}/descendants")
def get_descendants(req_id: UUID, db: Session = Depends(get_db)):
    """Walk downward from req_id, returning every descendant."""
    req = db.get(Requirement, req_id)
    if not req:
        raise HTTPException(status_code=404, detail="Requirement not found")

    visited: set[UUID] = set()
    queue: list[UUID] = [req_id]
    result = []

    while queue:
        current = queue.pop(0)
        if current in visited:
            continue
        visited.add(current)
        children = (
            db.query(RequirementLink.child_requirement_id)
            .filter(RequirementLink.parent_requirement_id == current)
            .all()
        )
        for (cid,) in children:
            if cid not in visited:
                child_req = db.get(Requirement, cid)
                if child_req:
                    result.append({
                        "id": str(child_req.id),
                        "requirement_id": child_req.requirement_id,
                        "title": child_req.title,
                    })
                queue.append(cid)

    return result
