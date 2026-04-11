"""Add document revision tracking and requirement stale flag

Revision ID: 015
Revises: 014
Create Date: 2026-04-10

superseded_by_id is a nullable self-FK on source_documents.  When a user
registers a new revision of an existing document the old row gets linked to
the new one via this column.  ON DELETE SET NULL means orphaned pointers are
cleared automatically if the new-revision document is ever deleted.

stale is a boolean flag on requirements.  It is bulk-set to true on all
requirements whose source_document_id matches the old document when a new
revision is registered.  Engineers then review each stale requirement and
decide whether to update it.
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import UUID as PG_UUID

revision = "015"
down_revision = "014"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "source_documents",
        sa.Column(
            "superseded_by_id",
            PG_UUID(as_uuid=True),
            sa.ForeignKey("source_documents.id", ondelete="SET NULL"),
            nullable=True,
        ),
    )
    op.add_column(
        "requirements",
        sa.Column(
            "stale",
            sa.Boolean,
            server_default=sa.text("false"),
            nullable=False,
        ),
    )


def downgrade() -> None:
    op.drop_column("source_documents", "superseded_by_id")
    op.drop_column("requirements", "stale")
