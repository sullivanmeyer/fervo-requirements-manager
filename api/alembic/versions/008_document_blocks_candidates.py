"""document_blocks and extraction_candidates tables

Revision ID: 008
Revises: 007
Create Date: 2026-04-07
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import UUID

revision = "008"
down_revision = "007"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # -------------------------------------------------------------------------
    # document_blocks
    # Each row is one clause/paragraph from a decomposed source document.
    # The parent_block_id self-reference encodes the clause hierarchy
    # (e.g., §5.3.1 has parent §5.3).
    # -------------------------------------------------------------------------
    op.create_table(
        "document_blocks",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "source_document_id",
            UUID(as_uuid=True),
            sa.ForeignKey("source_documents.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "parent_block_id",
            UUID(as_uuid=True),
            sa.ForeignKey("document_blocks.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("clause_number", sa.Text, nullable=True),
        sa.Column("heading", sa.Text, nullable=True),
        sa.Column("content", sa.Text, nullable=False),
        # heading / requirement_clause / table_row / informational / boilerplate
        sa.Column("block_type", sa.Text, nullable=False),
        sa.Column("sort_order", sa.Integer, nullable=False, server_default="0"),
        sa.Column("depth", sa.Integer, nullable=False, server_default="0"),
        sa.Column("created_at", sa.DateTime, nullable=False),
    )
    op.create_index(
        "ix_document_blocks_source_document_id",
        "document_blocks",
        ["source_document_id"],
    )

    # -------------------------------------------------------------------------
    # extraction_candidates
    # LLM-proposed requirements awaiting user review.  Once accepted, the
    # accepted_requirement_id FK points to the created Requirement row.
    # -------------------------------------------------------------------------
    op.create_table(
        "extraction_candidates",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "source_document_id",
            UUID(as_uuid=True),
            sa.ForeignKey("source_documents.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "source_block_id",
            UUID(as_uuid=True),
            sa.ForeignKey("document_blocks.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("title", sa.Text, nullable=False),
        sa.Column("statement", sa.Text, nullable=False),
        sa.Column("source_clause", sa.Text, nullable=True),
        # Requirement / Guideline
        sa.Column("suggested_classification", sa.Text, nullable=True),
        # Mechanical / Electrical / etc.
        sa.Column("suggested_discipline", sa.Text, nullable=True),
        # Pending / Accepted / Rejected / Edited
        sa.Column("status", sa.Text, nullable=False, server_default="Pending"),
        sa.Column(
            "accepted_requirement_id",
            UUID(as_uuid=True),
            sa.ForeignKey("requirements.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("created_at", sa.DateTime, nullable=False),
    )
    op.create_index(
        "ix_extraction_candidates_source_document_id",
        "extraction_candidates",
        ["source_document_id"],
    )


def downgrade() -> None:
    op.drop_index("ix_extraction_candidates_source_document_id")
    op.drop_table("extraction_candidates")
    op.drop_index("ix_document_blocks_source_document_id")
    op.drop_table("document_blocks")
