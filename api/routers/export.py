"""Requirements document export — Word (.docx) and PDF formats.

Generates a structured document organized by the system hierarchy tree, with
requirements listed under each node.  Accepts the same filter parameters as
the requirements list endpoint so the export scope matches what the user sees
in the table.

Word format uses python-docx (headings + paragraphs).
PDF format uses reportlab Platypus (headings + paragraphs).

Both formats are streamed back as file downloads so the browser triggers Save As.
"""
from __future__ import annotations

import io
from typing import Any, Optional
from uuid import UUID

from fastapi import APIRouter, Depends, Query
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session

from database import get_db
from models import HierarchyNode, Requirement

router = APIRouter()

SELF_DERIVED_ID = "SELF-000"


# ---------------------------------------------------------------------------
# Hierarchy helpers
# ---------------------------------------------------------------------------

def _build_tree_index(db: Session) -> tuple[dict[str, HierarchyNode], dict[str, list[str]]]:
    """Return (node_by_id, children_map) for all non-archived nodes."""
    all_nodes = (
        db.query(HierarchyNode)
        .filter(HierarchyNode.archived == False)  # noqa: E712
        .order_by(HierarchyNode.sort_order, HierarchyNode.name)
        .all()
    )
    node_by_id: dict[str, HierarchyNode] = {str(n.id): n for n in all_nodes}
    children_map: dict[str, list[str]] = {str(n.id): [] for n in all_nodes}
    for n in all_nodes:
        if n.parent_id and str(n.parent_id) in children_map:
            children_map[str(n.parent_id)].append(str(n.id))
    return node_by_id, children_map


def _dfs_order(node_by_id: dict, children_map: dict) -> list[tuple[str, int]]:
    """Return (node_id, depth) for every node in depth-first tree order."""
    roots = [nid for nid, n in node_by_id.items() if n.parent_id is None]
    result: list[tuple[str, int]] = []

    def dfs(nid: str, depth: int) -> None:
        result.append((nid, depth))
        for child_id in children_map.get(nid, []):
            dfs(child_id, depth + 1)

    for root_id in sorted(roots, key=lambda nid: node_by_id[nid].sort_order):
        dfs(root_id, 0)
    return result


def _req_dict(req: Requirement) -> dict[str, Any]:
    return {
        "id": req.requirement_id,
        "title": req.title,
        "classification": req.classification,
        "classification_subtype": req.classification_subtype,
        "statement": req.statement,
        "rationale": req.rationale,
        "source_clause": req.source_clause,
        "owner": req.owner,
        "status": req.status,
        "discipline": req.discipline,
        "source_document": req.source_document.title if req.source_document else None,
        "stale": req.stale,
    }


# ---------------------------------------------------------------------------
# Document generation
# ---------------------------------------------------------------------------

def _generate_word(
    doc_title: str,
    nodes_with_reqs: list[tuple[HierarchyNode, int, list[dict]]],
    unassigned: list[dict],
) -> bytes:
    from docx import Document  # type: ignore[import]
    from docx.shared import Pt, RGBColor  # type: ignore[import]
    from docx.enum.text import WD_ALIGN_PARAGRAPH  # type: ignore[import]

    doc = Document()
    doc.core_properties.title = doc_title

    title_para = doc.add_heading(doc_title, 0)
    title_para.alignment = WD_ALIGN_PARAGRAPH.LEFT

    def _add_requirement(req: dict) -> None:
        p = doc.add_paragraph()
        run = p.add_run(f"[{req['id']}]  {req['title']}")
        run.bold = True
        if req.get("stale"):
            run.font.color.rgb = RGBColor(0xB4, 0x5A, 0x09)

        class_text = req["classification"]
        if req.get("classification_subtype"):
            class_text += f" — {req['classification_subtype']}"
        stale_note = "  ⚠ STALE" if req.get("stale") else ""
        meta = doc.add_paragraph(
            f"Classification: {class_text}  |  Discipline: {req['discipline']}"
            f"  |  Status: {req['status']}  |  Owner: {req['owner']}{stale_note}"
        )
        for run in meta.runs:
            run.font.size = Pt(9)
        meta.paragraph_format.space_after = Pt(2)

        doc.add_paragraph(req["statement"])

        source_parts = []
        if req.get("source_document"):
            source_parts.append(f"Source: {req['source_document']}")
        if req.get("source_clause"):
            source_parts.append(f"Clause: {req['source_clause']}")
        if source_parts:
            sp = doc.add_paragraph("  ".join(source_parts))
            for run in sp.runs:
                run.font.size = Pt(9)

        doc.add_paragraph("")  # spacer

    for node, depth, reqs in nodes_with_reqs:
        level = min(depth + 1, 4)
        doc.add_heading(node.name, level)
        for req in reqs:
            _add_requirement(req)

    if unassigned:
        doc.add_heading("Unassigned Requirements", 1)
        for req in unassigned:
            _add_requirement(req)

    buf = io.BytesIO()
    doc.save(buf)
    return buf.getvalue()


def _generate_pdf(
    doc_title: str,
    nodes_with_reqs: list[tuple[HierarchyNode, int, list[dict]]],
    unassigned: list[dict],
) -> bytes:
    from reportlab.lib.pagesizes import LETTER  # type: ignore[import]
    from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle  # type: ignore[import]
    from reportlab.lib.units import inch  # type: ignore[import]
    from reportlab.lib import colors  # type: ignore[import]
    from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer  # type: ignore[import]

    buf = io.BytesIO()
    pdf_doc = SimpleDocTemplate(
        buf,
        pagesize=LETTER,
        leftMargin=inch,
        rightMargin=inch,
        topMargin=inch,
        bottomMargin=inch,
        title=doc_title,
    )
    styles = getSampleStyleSheet()

    h_styles = [
        ParagraphStyle("H1", parent=styles["Heading1"], fontSize=16, spaceAfter=8),
        ParagraphStyle("H2", parent=styles["Heading2"], fontSize=14, spaceAfter=6),
        ParagraphStyle("H3", parent=styles["Heading3"], fontSize=12, spaceAfter=4),
        ParagraphStyle("H4", parent=styles["Heading4"], fontSize=11, spaceAfter=4),
    ]
    req_id_style = ParagraphStyle(
        "ReqId", parent=styles["Normal"], fontSize=10,
        fontName="Helvetica-Bold", spaceAfter=2,
    )
    req_id_stale_style = ParagraphStyle(
        "ReqIdStale", parent=styles["Normal"], fontSize=10,
        fontName="Helvetica-Bold", textColor=colors.HexColor("#B45A09"), spaceAfter=2,
    )
    meta_style = ParagraphStyle(
        "Meta", parent=styles["Normal"], fontSize=8,
        textColor=colors.grey, spaceAfter=2,
    )
    body_style = ParagraphStyle(
        "Body", parent=styles["Normal"], fontSize=10, spaceAfter=4,
    )

    story = []
    story.append(Paragraph(doc_title, styles["Title"]))
    story.append(Spacer(1, 0.2 * inch))

    def _add_requirement(req: dict) -> None:
        id_text = f"[{req['id']}]  {req['title']}"
        if req.get("stale"):
            id_text += "  ⚠ STALE"
            story.append(Paragraph(id_text, req_id_stale_style))
        else:
            story.append(Paragraph(id_text, req_id_style))

        class_text = req["classification"]
        if req.get("classification_subtype"):
            class_text += f" — {req['classification_subtype']}"
        meta = (
            f"Classification: {class_text} | Discipline: {req['discipline']} "
            f"| Status: {req['status']} | Owner: {req['owner']}"
        )
        story.append(Paragraph(meta, meta_style))
        story.append(Paragraph(req["statement"], body_style))

        source_parts = []
        if req.get("source_document"):
            source_parts.append(f"Source: {req['source_document']}")
        if req.get("source_clause"):
            source_parts.append(f"Clause: {req['source_clause']}")
        if source_parts:
            story.append(Paragraph("  ".join(source_parts), meta_style))

        story.append(Spacer(1, 0.1 * inch))

    for node, depth, reqs in nodes_with_reqs:
        level = min(depth, 3)
        story.append(Paragraph(node.name, h_styles[level]))
        for req in reqs:
            _add_requirement(req)

    if unassigned:
        story.append(Paragraph("Unassigned Requirements", h_styles[0]))
        for req in unassigned:
            _add_requirement(req)

    pdf_doc.build(story)
    return buf.getvalue()


# ---------------------------------------------------------------------------
# Export endpoint
# ---------------------------------------------------------------------------

@router.get("/export/requirements-document")
def export_requirements(
    format: str = Query("word", pattern="^(word|pdf)$"),
    doc_title: str = Query("Requirements Document"),
    status: Optional[list[str]] = Query(None),
    classification: Optional[str] = Query(None),
    classification_subtype: Optional[str] = Query(None),
    discipline: Optional[list[str]] = Query(None),
    owner: Optional[str] = Query(None),
    hierarchy_node_id: Optional[str] = Query(None),
    include_descendants: bool = Query(False),
    stale: Optional[bool] = Query(None),
    db: Session = Depends(get_db),
):
    """
    Export all matching requirements as a Word (.docx) or PDF file, organized
    by the system hierarchy tree.  Accepts a subset of the list-requirements
    filter params so the exported scope matches what the user sees in the table.

    Requirements are grouped under their hierarchy node headings in tree order.
    Requirements assigned to no node appear at the end under "Unassigned".
    """
    from models import HierarchyNode as HN
    from sqlalchemy import or_

    base_q = db.query(Requirement).filter(
        Requirement.requirement_id != SELF_DERIVED_ID
    )
    if status:
        base_q = base_q.filter(Requirement.status.in_(status))
    if classification:
        base_q = base_q.filter(Requirement.classification == classification)
    if classification_subtype:
        base_q = base_q.filter(Requirement.classification_subtype == classification_subtype)
    if discipline:
        base_q = base_q.filter(Requirement.discipline.in_(discipline))
    if owner:
        base_q = base_q.filter(Requirement.owner.ilike(f"%{owner}%"))
    if stale is not None:
        base_q = base_q.filter(Requirement.stale == stale)

    if hierarchy_node_id:
        from routers.requirements import _collect_descendant_ids
        if include_descendants:
            node_ids = _collect_descendant_ids(hierarchy_node_id, db)
        else:
            node_ids = {UUID(hierarchy_node_id)}
        base_q = base_q.filter(
            Requirement.hierarchy_nodes.any(HN.id.in_(node_ids))
        )

    reqs = base_q.order_by(Requirement.requirement_id).all()

    # Build hierarchy index
    node_by_id, children_map = _build_tree_index(db)
    ordered_nodes = _dfs_order(node_by_id, children_map)

    # Group requirements by hierarchy node id
    node_to_reqs: dict[str, list[dict]] = {nid: [] for nid in node_by_id}
    assigned_req_ids: set[str] = set()
    for req in reqs:
        for node in req.hierarchy_nodes:
            nid = str(node.id)
            if nid in node_to_reqs:
                node_to_reqs[nid].append(_req_dict(req))
                assigned_req_ids.add(str(req.id))

    # Build the ordered list of (node, depth, reqs) — skip empty nodes
    nodes_with_reqs: list[tuple[HierarchyNode, int, list[dict]]] = []
    for nid, depth in ordered_nodes:
        if node_to_reqs.get(nid):
            nodes_with_reqs.append((node_by_id[nid], depth, node_to_reqs[nid]))

    # Requirements not assigned to any hierarchy node
    unassigned = [_req_dict(r) for r in reqs if str(r.id) not in assigned_req_ids]

    if format == "word":
        content = _generate_word(doc_title, nodes_with_reqs, unassigned)
        media_type = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        filename = f"{doc_title.replace(' ', '_')}.docx"
    else:
        content = _generate_pdf(doc_title, nodes_with_reqs, unassigned)
        media_type = "application/pdf"
        filename = f"{doc_title.replace(' ', '_')}.pdf"

    return StreamingResponse(
        io.BytesIO(content),
        media_type=media_type,
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
