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
POST   /requirement-blocks                           link a block to a requirement
DELETE /requirement-blocks                           unlink a block from a requirement
"""

from __future__ import annotations

import io
import uuid
from datetime import date, datetime
from typing import List, Optional
from uuid import UUID

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from database import get_db
from models import (
    DocumentBlock,
    DocumentReference,
    ExtractionCandidate,
    Requirement,
    RequirementBlock,
    RequirementLink,
    SourceDocument,
)
from routers.source_documents import _minio_client, BUCKET
from services.extraction import (
    decompose_document,
    detect_document_references,
    extract_requirements,
    _normalize_doc_id,
)

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
    table_data: Optional[dict] = None
    sort_order: int
    depth: int
    children: List["BlockOut"] = []

    class Config:
        from_attributes = True

BlockOut.model_rebuild()


class BlockUpdate(BaseModel):
    content: str
    table_data: Optional[dict] = None  # supplied when editing a table_block


class CandidateOut(BaseModel):
    id: str
    source_document_id: str
    source_block_id: Optional[str]
    title: str
    statement: str
    source_clause: Optional[str]
    suggested_classification: Optional[str]
    suggested_classification_subtype: Optional[str]
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
    title: Optional[str] = None                  # override suggested title
    statement: Optional[str] = None              # override suggested statement
    classification: Optional[str] = None         # override suggested classification
    classification_subtype: Optional[str] = None # override suggested subtype
    discipline: Optional[str] = None             # override suggested discipline
    hierarchy_node_ids: List[str] = []
    site_ids: List[str] = []
    unit_ids: List[str] = []
    parent_requirement_ids: List[str] = []


class MergeBlocksRequest(BaseModel):
    block_ids: List[str]
    owner: str


class AddRequirementBlockRequest(BaseModel):
    requirement_id: str
    block_id: str
    sort_order: Optional[int] = None   # appended to end if omitted


class RemoveRequirementBlockRequest(BaseModel):
    requirement_id: str
    block_id: str


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
        "table_data": block.table_data,
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
        "suggested_classification_subtype": c.suggested_classification_subtype,
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


def _block_plain_text(block: DocumentBlock) -> str:
    """Return a plain-text representation of a block for search-index fallback."""
    if block.block_type == "table_block" and block.table_data:
        td = block.table_data
        headers = td.get("headers") or []
        rows = td.get("rows") or []
        lines = [" | ".join(str(h) for h in headers)]
        for row in rows:
            lines.append(" | ".join(str(c) for c in row))
        return "\n".join(lines)
    return block.content


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
        "Build": "BUILD",
        "Operations": "OPS",
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
# Reference detection helper (shared by decomposition and on-demand endpoint)
# ---------------------------------------------------------------------------

def _apply_reference_detection(
    doc_uuid: UUID,
    source_doc: "SourceDocument",
    block_texts: list[str],
    db: "Session",
) -> dict:
    """
    Run Gemini reference detection on *block_texts*, create stub SourceDocument
    rows for any unrecognised references, and insert DocumentReference edges.

    Returns a summary dict: {detected, stubs_created, edges_added}.
    Safe to call on already-decomposed documents (idempotent — skips existing edges).
    """
    try:
        detected = detect_document_references(block_texts)
    except Exception as e:
        print(f"[detect_refs] WARNING: {e}")
        detected = []

    stubs_created = 0
    edges_added = 0

    if detected:
        all_docs = db.query(SourceDocument).all()
        existing_by_norm: dict[str, SourceDocument] = {
            _normalize_doc_id(d.document_id): d for d in all_docs
        }
        self_norm = _normalize_doc_id(source_doc.document_id)

        for ref in detected:
            norm = ref["normalized"]
            doc_num = ref["document_number"]
            full_ref = ref["full_reference"]
            context = ref["context"]

            if norm == self_norm:
                continue

            if norm in existing_by_norm:
                target = existing_by_norm[norm]
            else:
                target = SourceDocument(
                    id=uuid.uuid4(),
                    document_id=doc_num,
                    title=full_ref,
                    document_type="Code/Standard",
                    is_stub=True,
                    created_at=datetime.utcnow(),
                    updated_at=datetime.utcnow(),
                )
                db.add(target)
                db.flush()
                existing_by_norm[norm] = target
                stubs_created += 1
                print(f"[detect_refs] Created stub: {doc_num!r}")

            existing_edge = db.query(DocumentReference).filter(
                DocumentReference.source_document_id == doc_uuid,
                DocumentReference.referenced_document_id == target.id,
            ).first()
            if not existing_edge:
                db.add(DocumentReference(
                    id=uuid.uuid4(),
                    source_document_id=doc_uuid,
                    referenced_document_id=target.id,
                    reference_context=context,
                    created_at=datetime.utcnow(),
                ))
                edges_added += 1

        db.commit()
        print(
            f"[detect_refs] {len(detected)} refs detected, "
            f"{stubs_created} stubs created, {edges_added} edges added"
        )

    return {"detected": len(detected), "stubs_created": stubs_created, "edges_added": edges_added}


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

def _run_decomposition(doc_id: str, file_path: str):
    """
    Background task: fetch PDF from MinIO, call Gemini, persist blocks.
    Runs after the HTTP response has already been sent (no timeout risk).
    """
    from database import SessionLocal  # local import to avoid circular deps

    db = SessionLocal()
    try:
        minio = _minio_client()
        try:
            response = minio.get_object(BUCKET, file_path)
            pdf_bytes = response.read()
        finally:
            try:
                response.close()
                response.release_conn()
            except Exception:
                pass

        raw_blocks = decompose_document(pdf_bytes)

        doc_uuid = UUID(doc_id)
        doc = db.query(SourceDocument).filter(SourceDocument.id == doc_uuid).first()
        if not doc:
            print(f"[decompose] ERROR: doc {doc_id} not found in DB")
            return

        # Delete existing blocks
        db.query(DocumentBlock).filter(
            DocumentBlock.source_document_id == doc_uuid
        ).delete(synchronize_session=False)
        db.flush()

        clause_to_id: dict[str, UUID] = {}
        new_blocks: list[DocumentBlock] = []

        for raw in raw_blocks:
            block = DocumentBlock(
                id=uuid.uuid4(),
                source_document_id=doc_uuid,
                parent_block_id=None,
                clause_number=raw.get("clause_number"),
                heading=raw.get("heading"),
                content=raw.get("content", ""),
                block_type=raw.get("block_type", "informational"),
                table_data=raw.get("table_data"),
                sort_order=raw.get("sort_order", 0),
                depth=raw.get("depth", 0),
                created_at=datetime.utcnow(),
            )
            db.add(block)
            new_blocks.append(block)
            if block.clause_number:
                clause_to_id[block.clause_number] = block.id

        db.flush()

        for block, raw in zip(new_blocks, raw_blocks):
            parent_clause = raw.get("parent_clause_number")
            if parent_clause and parent_clause in clause_to_id:
                block.parent_block_id = clause_to_id[parent_clause]

        db.commit()
        print(f"[decompose] {len(new_blocks)} blocks written for doc {doc_id}")

        # ---- Reference detection ----
        block_texts = [b.content for b in new_blocks if b.content.strip()]
        _apply_reference_detection(doc_uuid, doc, block_texts, db)

    except Exception as e:
        db.rollback()
        print(f"[decompose] ERROR for doc {doc_id}: {e}")
    finally:
        db.close()


@router.post("/source-documents/{doc_id}/decompose", status_code=202)
def decompose(doc_id: str, background_tasks: BackgroundTasks, db: Session = Depends(get_db)):
    """
    Trigger LLM decomposition in the background and return 202 immediately.
    The frontend should poll GET /blocks until results appear.
    """
    doc = _get_doc_or_404(doc_id, db)

    if not doc.file_path:
        raise HTTPException(
            status_code=422,
            detail="No PDF uploaded for this document. Upload a PDF first.",
        )

    background_tasks.add_task(_run_decomposition, doc_id, doc.file_path)
    return {"status": "processing"}


@router.post("/source-documents/{doc_id}/detect-references")
def detect_references(doc_id: str, db: Session = Depends(get_db)):
    """
    Re-run reference detection on a document's existing blocks.

    Useful for documents that were decomposed before the automatic reference
    detection pipeline was added, or to refresh after editing blocks.
    Creates stub SourceDocument rows and DocumentReference edges for any
    newly-detected external references.
    """
    doc = _get_doc_or_404(doc_id, db)
    blocks = (
        db.query(DocumentBlock)
        .filter(DocumentBlock.source_document_id == UUID(doc_id))
        .order_by(DocumentBlock.sort_order)
        .all()
    )
    if not blocks:
        raise HTTPException(
            status_code=422,
            detail="No blocks found. Decompose the document first.",
        )
    block_texts = [b.content for b in blocks if b.content.strip()]
    result = _apply_reference_detection(UUID(doc_id), doc, block_texts, db)
    return result


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
    """Edit a block's content (and optionally its table_data for table_block type)."""
    block = db.query(DocumentBlock).filter(DocumentBlock.id == UUID(block_id)).first()
    if not block:
        raise HTTPException(status_code=404, detail="Block not found")
    block.content = body.content
    if body.table_data is not None:
        block.table_data = body.table_data
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
            suggested_classification_subtype=raw.get("suggested_classification_subtype"),
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
    classification_subtype = body.classification_subtype or c.suggested_classification_subtype
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

    # Determine content_source and statement before creating the requirement.
    # If the candidate has a source block we link to it; the statement becomes a
    # plain-text search-index fallback derived from the block's content.
    content_source = "manual"
    if c.source_block_id:
        source_block = db.query(DocumentBlock).filter(
            DocumentBlock.id == c.source_block_id
        ).first()
        if source_block:
            content_source = "block_linked"
            # Override statement with the plain-text fallback (unless the user
            # explicitly provided a statement override — which we still allow as
            # the search fallback so it doesn't lose the body content entirely)
            if not body.statement:
                statement = _block_plain_text(source_block)

    req = Requirement(
        id=uuid.uuid4(),
        requirement_id=req_id,
        title=title,
        statement=statement,
        classification=classification,
        classification_subtype=classification_subtype,
        owner=body.owner,
        source_type="Derived from Document",
        status="Draft",
        discipline=discipline,
        created_by=body.owner,
        created_date=date.today(),
        source_document_id=c.source_document_id,
        source_clause=c.source_clause,
        content_source=content_source,
        hierarchy_nodes=hier_nodes,
        sites=sites,
        units=units,
    )
    db.add(req)
    db.flush()

    # Create block linkage record for extraction-originated requirements
    if content_source == "block_linked" and c.source_block_id:
        req_block = RequirementBlock(
            id=uuid.uuid4(),
            requirement_id=req.id,
            block_id=c.source_block_id,
            sort_order=0,
            created_at=datetime.utcnow(),
        )
        db.add(req_block)

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
            "content_source": req.content_source,
        },
        "candidate": _candidate_to_dict(c),
    }


@router.post("/requirement-blocks", status_code=201)
def add_requirement_block(body: AddRequirementBlockRequest, db: Session = Depends(get_db)):
    """
    Link an existing document block to a requirement.

    Appends the block to the end of the requirement's linked block list (or
    inserts at the requested sort_order).  Sets content_source='block_linked'
    on the requirement if it isn't already.  Silently ignores duplicate links.
    Returns the updated linked_blocks list and content_source value.
    """
    req = db.get(Requirement, UUID(body.requirement_id))
    if not req:
        raise HTTPException(status_code=404, detail="Requirement not found")

    block = db.get(DocumentBlock, UUID(body.block_id))
    if not block:
        raise HTTPException(status_code=404, detail="Block not found")

    # Ignore if already linked
    existing = (
        db.query(RequirementBlock)
        .filter(
            RequirementBlock.requirement_id == req.id,
            RequirementBlock.block_id == block.id,
        )
        .first()
    )
    if not existing:
        if body.sort_order is not None:
            order = body.sort_order
        else:
            max_order = (
                db.query(RequirementBlock)
                .filter(RequirementBlock.requirement_id == req.id)
                .count()
            )
            order = max_order  # append to end (0-indexed)

        db.add(RequirementBlock(
            id=uuid.uuid4(),
            requirement_id=req.id,
            block_id=block.id,
            sort_order=order,
            created_at=datetime.utcnow(),
        ))

    req.content_source = "block_linked"
    db.commit()

    # Return updated linked_blocks
    rb_rows = (
        db.query(RequirementBlock, DocumentBlock)
        .join(DocumentBlock, RequirementBlock.block_id == DocumentBlock.id)
        .filter(RequirementBlock.requirement_id == req.id)
        .order_by(RequirementBlock.sort_order)
        .all()
    )
    linked_blocks = [
        {
            "id": str(blk.id),
            "source_document_id": str(blk.source_document_id),
            "clause_number": blk.clause_number,
            "heading": blk.heading,
            "content": blk.content,
            "block_type": blk.block_type,
            "table_data": blk.table_data,
            "depth": blk.depth,
            "sort_order": rb.sort_order,
        }
        for rb, blk in rb_rows
    ]
    return {"content_source": req.content_source, "linked_blocks": linked_blocks}


@router.delete("/requirement-blocks", status_code=200)
def remove_requirement_block(body: RemoveRequirementBlockRequest, db: Session = Depends(get_db)):
    """
    Unlink a document block from a requirement.

    If this was the last linked block, sets content_source='manual' so the
    requirement falls back to its plain-text statement field.
    Returns the updated content_source and linked_blocks list.
    """
    req = db.get(Requirement, UUID(body.requirement_id))
    if not req:
        raise HTTPException(status_code=404, detail="Requirement not found")

    rb = (
        db.query(RequirementBlock)
        .filter(
            RequirementBlock.requirement_id == req.id,
            RequirementBlock.block_id == UUID(body.block_id),
        )
        .first()
    )
    if rb:
        db.delete(rb)
        db.flush()

    # If no blocks remain, revert to manual mode
    remaining = (
        db.query(RequirementBlock)
        .filter(RequirementBlock.requirement_id == req.id)
        .count()
    )
    if remaining == 0:
        req.content_source = "manual"

    db.commit()

    # Return updated linked_blocks (empty list if reverted to manual)
    rb_rows = (
        db.query(RequirementBlock, DocumentBlock)
        .join(DocumentBlock, RequirementBlock.block_id == DocumentBlock.id)
        .filter(RequirementBlock.requirement_id == req.id)
        .order_by(RequirementBlock.sort_order)
        .all()
    )
    linked_blocks = [
        {
            "id": str(blk.id),
            "source_document_id": str(blk.source_document_id),
            "clause_number": blk.clause_number,
            "heading": blk.heading,
            "content": blk.content,
            "block_type": blk.block_type,
            "table_data": blk.table_data,
            "depth": blk.depth,
            "sort_order": rb.sort_order,
        }
        for rb, blk in rb_rows
    ]
    return {"content_source": req.content_source, "linked_blocks": linked_blocks}


@router.post("/source-documents/{doc_id}/merge-blocks", status_code=201)
def merge_blocks(doc_id: str, body: MergeBlocksRequest, db: Session = Depends(get_db)):
    """
    Create a block-linked requirement directly from selected document blocks.

    Loads the requested blocks in document sort_order, creates a Requirement with
    content_source='block_linked', and writes requirement_blocks junction records
    so the detail view renders the original block content instead of copied text.

    Returns {id, requirement_id} — the caller should navigate to the requirement
    detail view so the user can fill in metadata (title, classification, etc.).
    """
    _get_doc_or_404(doc_id, db)

    if not body.block_ids:
        raise HTTPException(status_code=422, detail="block_ids must not be empty")

    # Load blocks in document reading order regardless of selection order
    blocks = (
        db.query(DocumentBlock)
        .filter(
            DocumentBlock.source_document_id == UUID(doc_id),
            DocumentBlock.id.in_([UUID(bid) for bid in body.block_ids]),
        )
        .order_by(DocumentBlock.sort_order)
        .all()
    )

    if not blocks:
        raise HTTPException(status_code=404, detail="No matching blocks found for this document")

    # Build plain-text statement fallback (used for search indexing, not display)
    statement = "\n\n".join(_block_plain_text(b) for b in blocks)

    req_id = _next_requirement_id("General", db)

    req = Requirement(
        id=uuid.uuid4(),
        requirement_id=req_id,
        title="Untitled merged requirement",
        statement=statement,
        classification="Requirement",
        owner=body.owner,
        source_type="Derived from Document",
        status="Draft",
        discipline="General",
        created_by=body.owner,
        created_date=date.today(),
        source_document_id=UUID(doc_id),
        content_source="block_linked",
    )
    db.add(req)
    db.flush()

    for i, block in enumerate(blocks):
        db.add(RequirementBlock(
            id=uuid.uuid4(),
            requirement_id=req.id,
            block_id=block.id,
            sort_order=i,
            created_at=datetime.utcnow(),
        ))

    db.commit()

    return {"id": str(req.id), "requirement_id": req.requirement_id}
