"""GIN full-text search indexes on requirements and source_documents

Revision ID: 013
Revises: 012
Create Date: 2026-04-10

These are functional GIN indexes — no new columns are added.  PostgreSQL builds
a tsvector on-the-fly from the indexed expression and stores it in the index.
The application query must use the identical expression to benefit from the index.
"""
from alembic import op
import sqlalchemy as sa

revision = "013"
down_revision = "012"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Requirements: title + statement + rationale + owner + tags
    # Cast 'english' to regconfig so PostgreSQL recognises the expression as IMMUTABLE.
    op.execute(sa.text("""
        CREATE INDEX idx_requirements_fts ON requirements USING GIN (
            to_tsvector('english'::regconfig,
                coalesce(title, '') || ' ' ||
                coalesce(statement, '') || ' ' ||
                coalesce(rationale, '') || ' ' ||
                coalesce(owner, '') || ' ' ||
                array_to_string(coalesce(tags, ARRAY[]::text[]), ' ')
            )
        )
    """))

    # Source documents: title + document_id
    op.execute(sa.text("""
        CREATE INDEX idx_source_documents_fts ON source_documents USING GIN (
            to_tsvector('english'::regconfig, coalesce(title, '') || ' ' || coalesce(document_id, ''))
        )
    """))


def downgrade() -> None:
    op.execute(sa.text("DROP INDEX IF EXISTS idx_requirements_fts"))
    op.execute(sa.text("DROP INDEX IF EXISTS idx_source_documents_fts"))
