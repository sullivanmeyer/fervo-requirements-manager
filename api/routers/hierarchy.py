from __future__ import annotations

from datetime import datetime
from typing import Any
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from database import get_db
from models import HierarchyNode, Requirement
from schemas import HierarchyNodeCreate, HierarchyNodeUpdate

router = APIRouter()


def _node_to_dict(node: HierarchyNode) -> dict[str, Any]:
    return {
        "id": str(node.id),
        "parent_id": str(node.parent_id) if node.parent_id else None,
        "name": node.name,
        "description": node.description,
        "applicable_disciplines": node.applicable_disciplines or [],
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


@router.get("/hierarchy/{node_id}/ancestors")
def get_ancestors(node_id: UUID, db: Session = Depends(get_db)):
    """Return the ordered ancestor chain from root down to (and including) node_id."""
    node = db.get(HierarchyNode, node_id)
    if not node or node.archived:
        raise HTTPException(status_code=404, detail="Node not found")

    chain: list[dict[str, Any]] = []
    current: HierarchyNode | None = node
    while current is not None:
        chain.append({"id": str(current.id), "name": current.name})
        current = db.get(HierarchyNode, current.parent_id) if current.parent_id else None

    chain.reverse()  # root → node
    return chain


@router.get("/hierarchy/{node_id}/block-view")
def get_block_view(node_id: UUID, db: Session = Depends(get_db)):
    """
    Return a single-level block-diagram payload for the given node:
      - node info
      - Performance Requirements linked directly to this node
      - direct non-archived children, each with has_children, children_preview, and their
        own Performance Requirements
    """
    node = db.get(HierarchyNode, node_id)
    if not node or node.archived:
        raise HTTPException(status_code=404, detail="Node not found")

    # Direct non-archived children
    children: list[HierarchyNode] = (
        db.query(HierarchyNode)
        .filter(
            HierarchyNode.parent_id == node_id,
            HierarchyNode.archived == False,  # noqa: E712
        )
        .order_by(HierarchyNode.sort_order)
        .all()
    )

    child_ids = [c.id for c in children]

    # Grandchildren — used for has_children flag and children_preview tags
    grandchildren: list[HierarchyNode] = []
    if child_ids:
        grandchildren = (
            db.query(HierarchyNode)
            .filter(
                HierarchyNode.parent_id.in_(child_ids),
                HierarchyNode.archived == False,  # noqa: E712
            )
            .order_by(HierarchyNode.sort_order)
            .all()
        )

    gc_by_parent: dict[str, list[str]] = {}
    gc_has_children: set[str] = set()
    for gc in grandchildren:
        pid = str(gc.parent_id)
        gc_by_parent.setdefault(pid, []).append(gc.name)
        gc_has_children.add(pid)

    # Fetch Performance and Derived Requirements for this node and all its direct children
    all_node_ids = [node_id] + child_ids
    perf_reqs: list[Requirement] = (
        db.query(Requirement)
        .filter(
            Requirement.classification_subtype.in_(["Performance Requirement", "Derived Requirement"]),
            Requirement.hierarchy_nodes.any(HierarchyNode.id.in_(all_node_ids)),
        )
        .order_by(Requirement.requirement_id)
        .all()
    )

    # Group requirements by which node(s) in our set they are assigned to.
    # A requirement assigned to multiple nodes appears in each bucket.
    all_node_id_strs = {str(nid) for nid in all_node_ids}
    node_reqs: dict[str, list[dict[str, Any]]] = {str(nid): [] for nid in all_node_ids}
    seen_per_node: dict[str, set[str]] = {str(nid): set() for nid in all_node_ids}

    def _req_dict(r: Requirement) -> dict[str, Any]:
        return {
            "id": str(r.id),
            "requirement_id": r.requirement_id,
            "title": r.title,
            "status": r.status,
        }

    for req in perf_reqs:
        req_id_str = str(req.id)
        for hn in req.hierarchy_nodes:
            hn_id_str = str(hn.id)
            if hn_id_str in all_node_id_strs and req_id_str not in seen_per_node[hn_id_str]:
                node_reqs[hn_id_str].append(_req_dict(req))
                seen_per_node[hn_id_str].add(req_id_str)

    # System Interface requirements — returned separately as connection arrows
    iface_reqs: list[Requirement] = (
        db.query(Requirement)
        .filter(
            Requirement.classification_subtype == "System Interface",
            Requirement.hierarchy_nodes.any(HierarchyNode.id.in_(all_node_ids)),
        )
        .order_by(Requirement.requirement_id)
        .all()
    )

    interface_connections: list[dict[str, Any]] = []
    for req in iface_reqs:
        assigned_ids = [str(hn.id) for hn in req.hierarchy_nodes]
        visible_ids = [nid for nid in assigned_ids if nid in all_node_id_strs]
        if not visible_ids:
            continue
        external_nodes = [
            {"id": str(hn.id), "name": hn.name}
            for hn in req.hierarchy_nodes
            if str(hn.id) not in all_node_id_strs
        ]
        interface_connections.append({
            **_req_dict(req),
            "node_ids": visible_ids,
            "external_nodes": external_nodes,
        })

    return {
        "node": {
            "id": str(node.id),
            "name": node.name,
            "description": node.description,
        },
        "performance_requirements": node_reqs[str(node_id)],
        "children": [
            {
                "id": str(c.id),
                "name": c.name,
                "description": c.description,
                "has_children": str(c.id) in gc_has_children,
                "children_preview": gc_by_parent.get(str(c.id), []),
                "performance_requirements": node_reqs[str(c.id)],
            }
            for c in children
        ],
        "interface_connections": interface_connections,
    }
