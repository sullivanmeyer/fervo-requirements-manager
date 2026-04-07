"""
Extraction router — block-based document decomposition and LLM-assisted
requirement extraction.

Endpoints
---------
POST   /source-documents/{doc_id}/decompose          trigger LLM decomposition
GET    /source-documents/{doc_id}/blocks             list blocks (nested tree)
PUT    /document-blocks/{block_id}                   edit a block's content
POST   /source-documents/{doc_id}/extract-requirements  trigger LLM extraction
GET    /source-documents/{doc_id}/candidates         list extraction candidates
PUT    /extraction-candidates/{candidate_id}         update a candidate
POST   /extraction-candidates/{candidate_id}/accept  accept → create requirement
"""

from __future__ import annotations

import io
import uuid
from datetime import date, datetime
from typing import List, Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from database import get_db
from models import (
    DocumentBlock,
    ExtractionCandidate,
    Requirement,
    RequirementLink,
    SourceDocument,
)
from routers.source_documents import _get_minio_client, BUCKET
from services.extraction import decompose_document, extract_requirements

router = APIRouter()

# ---------------------------------------------------------------------------
# Pydantic schemas (request / response bodies)
# ---------------------------------------------------------------------------

class BlockOut(BaseModel):
    id: str
    source_document_id: str
    parent_block_id: Optional[str]
    clause_number: Optional[str]
    heading: Optional[str]
    content: str
    block_type: str
    sort_order: int
    depth: int
    children: List["BlockOut"] = []

    class Config:
        from_attributes = True

BlockOut.model_rebuild()


class BlockUpdate(BaseModel):
    content: str


class CandidateOut(BaseModel):
    id: str
    source_document_id: str
    source_block_id: Optional[str]
    title: str
    statement: str
    source_clause: Optional[str]
    suggested_classification: Optional[str]
    suggested_discipline: Optional[str]
    status: str
    accepted_requirement_id: Optional[str]
    created_at: str


class CandidateUpdate(BaseModel):
    title: Optional[str] = None
    statement: Optional[str] = None
    source_clause: Optional[str] = None
    suggested_classification: Optional[str] = None
    suggested_discipline: Optional[str] = None
    status: Optional[str] = None


class AcceptCandidateRequest(BaseModel):
    owner: str
    title: Optional[str] = None          # override suggested title
    statement: Optional[str] = None      # override suggested statement
    classification: Optional[str] = None # override suggested classification
    discipline: Optional[str] = None     # override suggested discipline
    hierarchy_node_ids: List[str] = []
    site_ids: List[str] = []
    unit_ids: List[str] = []
    parent_requirement_ids: List[str] = []


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _block_to_dict(block: DocumentBlock, include_children: bool = True) -> dict:
    d = {
        "id": str(block.id),
        "source_document_id": str(block.source_document_id),
        "parent_block_id": str(block.parent_block_id) if block.parent_block_id else None,
        "clause_number": block.clause_number,
        "heading": block.heading,
        "content": block.content,
        "block_type": block.block_type,
        "sort_order": block.sort_order,
        "depth": block.depth,
        "children": [],
    }
    return d


def _candidate_to_dict(c: ExtractionCandidate) -> dict:
    return {
        "id": str(c.id),
        "source_document_id": str(c.source_document_id),
        "source_block_id": str(c.source_block_id) if c.source_block_id else None,
        "title": c.title,
        "statement": c.statement,
        "source_clause": c.source_clause,
        "suggested_classification": c.suggested_classification,
        "suggested_discipline": c.suggested_discipline,
        "status": c.status,
        "accepted_requirement_id": str(c.accepted_requirement_id) if c.accepted_requirement_id else None,
        "created_at": c.created_at.isoformat(),
    }


def _build_block_tree(blocks: list[DocumentBlock]) -> list[dict]:
    """Convert a flat list of DocumentBlock rows into a nested tree."""
    # Index by id
    by_id: dict[str, dict] = {}
    for b in blocks:
        by_id[str(b.id)] = _block_to_dict(b)

    roots: list[dict] = []
    for b in blocks:
        d = by_id[str(b.id)]
        if b.parent_block_id and str(b.parent_block_id) in by_id:
            by_id[str(b.parent_block_id)]["children"].append(d)
        else:
            roots.append(d)
    return roots


def _get_doc_or_404(doc_id: str, db: Session) -> SourceDocument:
    doc = db.query(SourceDocument).filter(SourceDocument.id == UUID(doc_id)).first()
    if not doc:
        raise HTTPException(status_code=404, detail="Source document not found")
    return doc


def _next_requirement_id(discipline: str, db: Session) -> str:
    """Generate the next sequential requirement ID for this discipline."""
    prefixes = {
        "Mechanical": "MECH",
        "Electrical": "ELEC",
        "I&C": "IC",
        "Civil/Structural": "STRUC",
        "Process": "PROC",
        "Fire Protection": "FP",
        "General": "GEN",
    }
    prefix = prefixes.get(discipline, "GEN")
    existing = (
        db.query(Requirement.requirement_id)
        .filter(Requirement.requirement_id.like(f"{prefix}-%"))
        .all()
    )
    seq = len(existing) + 1
    return f"{prefix}-{seq:03d}"


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@router.post("/source-documents/{doc_id}/decompose")
def decompose(doc_id: str, db: Session = Depends(get_db)):
    """
    Trigger LLM decomposition of a source document PDF into structured blocks.
    Idempotent: re-running deletes existing blocks and re-creates them.
    Returns the block tree.
    """
    doc = _get_doc_or_404(doc_id, db)

    if not doc.file_path:
        raise HTTPException(
            status_code=422,
            detail="No PDF uploaded for this document. Upload a PDF first.",
        )

    # Fetch PDF bytes from MinIO
    minio = _get_minio_client()
    try:
        response = minio.get_object(BUCKET, doc.file_path)
        pdf_bytes = response.read()
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Could not read PDF from storage: {e}")
    finally:
        try:
            response.close()
            response.release_conn()
        except Exception:
            pass

    # Call LLM
    try:
        raw_blocks = decompose_document(pdf_bytes)
    except RuntimeError as e:
        raise HTTPException(status_code=503, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"LLM decomposition failed: {e}")

    # Delete existing blocks (cascade will also remove their children)
    db.query(DocumentBlock).filter(
        DocumentBlock.source_document_id == doc.id
    ).delete(synchronize_session=False)
    db.flush()

    # Build clause_number → block_id map so we can resolve parent_block_id
    # We do a two-pass insert: first create all blocks without parents,
    # then update parent_block_id references.
    clause_to_id: dict[str, UUID] = {}
    new_blocks: list[DocumentBlock] = []

    for raw in raw_blocks:
        block = DocumentBlock(
            id=uuid.uuid4(),
            source_document_id=doc.id,
            parent_block_id=None,   # resolved in second pass
            clause_number=raw.get("clause_number"),
            heading=raw.get("heading"),
            content=raw.get("content", ""),
            block_type=raw.get("block_type", "informational"),
            sort_order=raw.get("sort_order", 0),
            depth=raw.get("depth", 0),
            created_at=datetime.utcnow(),
        )
        db.add(block)
        new_blocks.append(block)
        if block.clause_number:
            clause_to_id[block.clause_number] = block.id

    db.flush()

    # Second pass: wire up parent references
    for block, raw in zip(new_blocks, raw_blocks):
        parent_clause = raw.get("parent_clause_number")
        if parent_clause and parent_clause in clause_to_id:
            block.parent_block_id = clause_to_id[parent_clause]

    db.commit()

    # Return flat list (frontend builds tree via sort_order / depth)
    all_blocks = (
        db.query(DocumentBlock)
        .filter(DocumentBlock.source_document_id == doc.id)
        .order_by(DocumentBlock.sort_order)
        .all()
    )
    return {"blocks": [_block_to_dict(b) for b in all_blocks]}


@router.get("/source-documents/{doc_id}/blocks")
def list_blocks(doc_id: str, db: Session = Depends(get_db)):
    """Return blocks for a document as a flat list ordered by sort_order."""
    _get_doc_or_404(doc_id, db)
    blocks = (
        db.query(DocumentBlock)
        .filter(DocumentBlock.source_document_id == UUID(doc_id))
        .order_by(DocumentBlock.sort_order)
        .all()
    )
    return {"blocks": [_block_to_dict(b) for b in blocks]}


@router.put("/document-blocks/{block_id}")
def update_block(block_id: str, body: BlockUpdate, db: Session = Depends(get_db)):
    """Edit a block's content (user correction of parsing errors)."""
    block = db.query(DocumentBlock).filter(DocumentBlock.id == UUID(block_id)).first()
    if not block:
        raise HTTPException(status_code=404, detail="Block not found")
    block.content = body.content
    db.commit()
    db.refresh(block)
    return _block_to_dict(block)


@router.post("/source-documents/{doc_id}/extract-requirements")
def extract(
    doc_id: str,
    body: dict = {},
    db: Session = Depends(get_db),
):
    """
    Trigger LLM extraction from blocks.
    Optional body: { "block_ids": ["uuid", ...] } to extract from specific blocks.
    If block_ids is omitted or empty, extracts from all non-boilerplate blocks.
    Returns newly created candidates.
    """
    _get_doc_or_404(doc_id, db)

    block_ids: list[str] = body.get("block_ids", []) if body else []

    # Load blocks
    query = db.query(DocumentBlock).filter(
        DocumentBlock.source_document_id == UUID(doc_id)
    )
    if block_ids:
        query = query.filter(
            DocumentBlock.id.in_([UUID(bid) for bid in block_ids])
        )
    else:
        # Exclude boilerplate when extracting all
        query = query.filter(DocumentBlock.block_type != "boilerplate")

    blocks = query.order_by(DocumentBlock.sort_order).all()

    if not blocks:
        raise HTTPException(
            status_code=422,
            detail="No blocks found. Run decomposition first or provide valid block_ids.",
        )

    # Call LLM
    block_dicts = [
        {
            "clause_number": b.clause_number,
            "block_type": b.block_type,
            "content": b.content,
        }
        for b in blocks
    ]
    try:
        raw_candidates = extract_requirements(block_dicts)
    except RuntimeError as e:
        raise HTTPException(status_code=503, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"LLM extraction failed: {e}")

    # Persist candidates
    new_candidates: list[ExtractionCandidate] = []
    for raw in raw_candidates:
        # Map source_block_index → block id
        idx = raw.get("source_block_index", 0)
        source_block_id = blocks[idx].id if 0 <= idx < len(blocks) else None

        candidate = ExtractionCandidate(
            id=uuid.uuid4(),
            source_document_id=UUID(doc_id),
            source_block_id=source_block_id,
            title=raw["title"],
            statement=raw["statement"],
            source_clause=raw.get("source_clause"),
            suggested_classification=raw.get("suggested_classification", "Requirement"),
            suggested_discipline=raw.get("suggested_discipline", "General"),
            status="Pending",
            accepted_requirement_id=None,
            created_at=datetime.utcnow(),
        )
        db.add(candidate)
        new_candidates.append(candidate)

    db.commit()
    return {"candidates": [_candidate_to_dict(c) for c in new_candidates]}


@router.get("/source-documents/{doc_id}/candidates")
def list_candidates(doc_id: str, db: Session = Depends(get_db)):
    """List all extraction candidates for a document, newest first."""
    _get_doc_or_404(doc_id, db)
    candidates = (
        db.query(ExtractionCandidate)
        .filter(ExtractionCandidate.source_document_id == UUID(doc_id))
        .order_by(ExtractionCandidate.created_at)
        .all()
    )
    return {"candidates": [_candidate_to_dict(c) for c in candidates]}


@router.put("/extraction-candidates/{candidate_id}")
def update_candidate(
    candidate_id: str, body: CandidateUpdate, db: Session = Depends(get_db)
):
    """Update a candidate's fields or status (Pending → Rejected, etc.)."""
    c = db.query(ExtractionCandidate).filter(
        ExtractionCandidate.id == UUID(candidate_id)
    ).first()
    if not c:
        raise HTTPException(status_code=404, detail="Candidate not found")

    if body.title is not None:
        c.title = body.title
    if body.statement is not None:
        c.statement = body.statement
    if body.source_clause is not None:
        c.source_clause = body.source_clause
    if body.suggested_classification is not None:
        c.suggested_classification = body.suggested_classification
    if body.suggested_discipline is not None:
        c.suggested_discipline = body.suggested_discipline
    if body.status is not None:
        valid = {"Pending", "Accepted", "Rejected", "Edited"}
        if body.status not in valid:
            raise HTTPException(status_code=422, detail=f"status must be one of {valid}")
        c.status = body.status

    db.commit()
    db.refresh(c)
    return _candidate_to_dict(c)


@router.post("/extraction-candidates/{candidate_id}/accept")
def accept_candidate(
    candidate_id: str,
    body: AcceptCandidateRequest,
    db: Session = Depends(get_db),
):
    """
    Accept an extraction candidate: create a real Requirement and mark the
    candidate as Accepted.  Returns the created requirement dict.
    """
    c = db.query(ExtractionCandidate).filter(
        ExtractionCandidate.id == UUID(candidate_id)
    ).first()
    if not c:
        raise HTTPException(status_code=404, detail="Candidate not found")

    if c.status == "Accepted":
        raise HTTPException(status_code=409, detail="Candidate already accepted")

    # Resolve field values (body overrides take precedence over LLM suggestions)
    title = (body.title or c.title)[:120]
    statement = body.statement or c.statement
    classification = body.classification or c.suggested_classification or "Requirement"
    discipline = body.discipline or c.suggested_discipline or "General"

    req_id = _next_requirement_id(discipline, db)

    # Resolve junction table references
    from models import HierarchyNode, Site, Unit
    hier_nodes = (
        db.query(HierarchyNode)
        .filter(HierarchyNode.id.in_([UUID(x) for x in body.hierarchy_node_ids]))
        .all()
        if body.hierarchy_node_ids else []
    )
    sites = (
        db.query(Site)
        .filter(Site.id.in_([UUID(x) for x in body.site_ids]))
        .all()
        if body.site_ids else []
    )
    units = (
        db.query(Unit)
        .filter(Unit.id.in_([UUID(x) for x in body.unit_ids]))
        .all()
        if body.unit_ids else []
    )

    req = Requirement(
        id=uuid.uuid4(),
        requirement_id=req_id,
        title=title,
        statement=statement,
        classification=classification,
        owner=body.owner,
        source_type="Derived from Document",
        status="Draft",
        discipline=discipline,
        created_by=body.owner,
        created_date=date.today(),
        source_document_id=c.source_document_id,
        source_clause=c.source_clause,
        hierarchy_nodes=hier_nodes,
        sites=sites,
        units=units,
    )
    db.add(req)
    db.flush()

    # Add parent traceability links
    for parent_id_str in body.parent_requirement_ids:
        link = RequirementLink(
            parent_requirement_id=UUID(parent_id_str),
            child_requirement_id=req.id,
            created_at=datetime.utcnow(),
        )
        db.add(link)

    # Mark candidate accepted
    c.status = "Accepted"
    c.accepted_requirement_id = req.id
    db.commit()

    return {
        "requirement": {
            "id": str(req.id),
            "requirement_id": req.requirement_id,
            "title": req.title,
            "statement": req.statement,
            "classification": req.classification,
            "status": req.status,
            "discipline": req.discipline,
            "owner": req.owner,
            "source_document_id": str(req.source_document_id),
            "source_clause": req.source_clause,
        },
        "candidate": _candidate_to_dict(c),
    }
