from __future__ import annotations

from datetime import datetime
from typing import Any
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from database import get_db
from models import HierarchyNode
from schemas import HierarchyNodeCreate, HierarchyNodeUpdate

router = APIRouter()


def _node_to_dict(node: HierarchyNode) -> dict[str, Any]:
    return {
        "id": str(node.id),
        "parent_id": str(node.parent_id) if node.parent_id else None,
        "name": node.name,
        "description": node.description,
        "archived": node.archived,
        "sort_order": node.sort_order,
        "created_at": node.created_at.isoformat(),
        "updated_at": node.updated_at.isoformat(),
        "children": [],
    }


def _build_tree(nodes: list[HierarchyNode]) -> list[dict[str, Any]]:
    """Assemble a flat list of ORM nodes into a nested tree dict."""
    node_map: dict[str, dict] = {str(n.id): _node_to_dict(n) for n in nodes}

    roots: list[dict] = []
    for n in nodes:
        d = node_map[str(n.id)]
        parent_key = str(n.parent_id) if n.parent_id else None
        if parent_key is None or parent_key not in node_map:
            roots.append(d)
        else:
            node_map[parent_key]["children"].append(d)

    def _sort(items: list[dict]) -> None:
        items.sort(key=lambda x: x["sort_order"])
        for item in items:
            _sort(item["children"])

    _sort(roots)
    return roots


@router.get("/hierarchy")
def get_hierarchy(db: Session = Depends(get_db)):
    nodes = (
        db.query(HierarchyNode)
        .filter(HierarchyNode.archived == False)  # noqa: E712
        .all()
    )
    return _build_tree(nodes)


@router.post("/hierarchy", status_code=201)
def create_node(data: HierarchyNodeCreate, db: Session = Depends(get_db)):
    if data.parent_id:
        parent = db.get(HierarchyNode, data.parent_id)
        if not parent or parent.archived:
            raise HTTPException(status_code=404, detail="Parent node not found")

    node = HierarchyNode(**data.model_dump())
    db.add(node)
    db.commit()
    db.refresh(node)
    return _node_to_dict(node)


@router.put("/hierarchy/{node_id}")
def update_node(
    node_id: UUID, data: HierarchyNodeUpdate, db: Session = Depends(get_db)
):
    node = db.get(HierarchyNode, node_id)
    if not node:
        raise HTTPException(status_code=404, detail="Node not found")

    if data.parent_id is not None and str(data.parent_id) == str(node_id):
        raise HTTPException(status_code=400, detail="A node cannot be its own parent")

    if data.parent_id is not None:
        parent = db.get(HierarchyNode, data.parent_id)
        if not parent or parent.archived:
            raise HTTPException(status_code=404, detail="Parent node not found")

    for field, value in data.model_dump(exclude_unset=True).items():
        setattr(node, field, value)

    node.updated_at = datetime.utcnow()
    db.commit()
    db.refresh(node)
    return _node_to_dict(node)


@router.patch("/hierarchy/{node_id}/archive")
def archive_node(node_id: UUID, db: Session = Depends(get_db)):
    node = db.get(HierarchyNode, node_id)
    if not node:
        raise HTTPException(status_code=404, detail="Node not found")

    node.archived = True
    node.updated_at = datetime.utcnow()
    db.commit()
    db.refresh(node)
    return _node_to_dict(node)
