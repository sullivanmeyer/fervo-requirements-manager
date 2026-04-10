from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from sqlalchemy import text
from sqlalchemy.orm import Session

from database import get_db
from models import Requirement, SourceDocument

router = APIRouter()

SELF_DERIVED_ID = "SELF-000"

# ---------------------------------------------------------------------------
# Full-text search
# ---------------------------------------------------------------------------

_REQ_TSVEC = """
    to_tsvector('english'::regconfig,
        coalesce(title, '') || ' ' ||
        coalesce(statement, '') || ' ' ||
        coalesce(rationale, '') || ' ' ||
        coalesce(owner, '') || ' ' ||
        array_to_string(coalesce(tags, ARRAY[]::text[]), ' ')
    )
"""

_DOC_TSVEC = """
    to_tsvector('english'::regconfig, coalesce(title, '') || ' ' || coalesce(document_id, ''))
"""


@router.get("/search")
def global_search(
    q: str = Query(..., min_length=3),
    db: Session = Depends(get_db),
):
    """
    Full-text search across requirements (title, statement, rationale, owner,
    tags) and source documents (title, document_id).

    Uses PostgreSQL plainto_tsquery so the user can type natural phrases without
    learning tsquery syntax.  The functional GIN indexes added in migration 013
    make this fast even on large datasets.
    """
    requirements = (
        db.query(Requirement)
        .filter(
            text(f"{_REQ_TSVEC} @@ plainto_tsquery('english', :q)").bindparams(q=q)
        )
        .filter(Requirement.requirement_id != SELF_DERIVED_ID)
        .order_by(Requirement.requirement_id)
        .limit(30)
        .all()
    )

    source_documents = (
        db.query(SourceDocument)
        .filter(
            text(f"{_DOC_TSVEC} @@ plainto_tsquery('english', :q)").bindparams(q=q)
        )
        .order_by(SourceDocument.document_id)
        .limit(15)
        .all()
    )

    return {
        "requirements": [
            {
                "id": str(r.id),
                "requirement_id": r.requirement_id,
                "title": r.title,
                "discipline": r.discipline,
                "status": r.status,
                "owner": r.owner,
            }
            for r in requirements
        ],
        "source_documents": [
            {
                "id": str(d.id),
                "document_id": d.document_id,
                "title": d.title,
                "document_type": d.document_type,
            }
            for d in source_documents
        ],
    }
