"""document_references table

Revision ID: 009
Revises: 008
Create Date: 2026-04-08
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import UUID

revision = "009"
down_revision = "008"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # -------------------------------------------------------------------------
    # document_references
    # One row = "source_document references referenced_document".
    # Unique constraint prevents duplicate edges in the graph.
    # reference_context optionally captures the clause/phrase that triggered
    # the reference (e.g. "per API 661 §5.1").
    # -------------------------------------------------------------------------
    op.create_table(
        "document_references",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "source_document_id",
            UUID(as_uuid=True),
            sa.ForeignKey("source_documents.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "referenced_document_id",
            UUID(as_uuid=True),
            sa.ForeignKey("source_documents.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("reference_context", sa.Text, nullable=True),
        sa.Column("created_at", sa.DateTime, nullable=False),
    )
    # Prevent duplicate (A → B) edges
    op.create_unique_constraint(
        "uq_document_references_pair",
        "document_references",
        ["source_document_id", "referenced_document_id"],
    )
    op.create_index(
        "ix_document_references_source_document_id",
        "document_references",
        ["source_document_id"],
    )
    op.create_index(
        "ix_document_references_referenced_document_id",
        "document_references",
        ["referenced_document_id"],
    )


def downgrade() -> None:
    op.drop_index("ix_document_references_referenced_document_id")
    op.drop_index("ix_document_references_source_document_id")
    op.drop_constraint("uq_document_references_pair", "document_references")
    op.drop_table("document_references")
