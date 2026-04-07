"""Source document registry

Revision ID: 005
Revises: 004
Create Date: 2026-04-06

Creates the source_documents table and adds source_document_id / source_clause
columns to the requirements table so requirements can be traced back to their
originating document and specific clause.
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "005"
down_revision = "004"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # ------------------------------------------------------------------
    # source_documents: one record per registered source document.
    # file_path stores the MinIO object key (e.g. "documents/DOC-001.pdf").
    # extracted_text is populated automatically on PDF upload.
    # ------------------------------------------------------------------
    op.create_table(
        "source_documents",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
            nullable=False,
        ),
        sa.Column("document_id", sa.Text(), nullable=False, unique=True),
        sa.Column("title", sa.Text(), nullable=False),
        sa.Column("document_type", sa.Text(), nullable=False),
        sa.Column("revision", sa.Text(), nullable=True),
        sa.Column("issuing_organization", sa.Text(), nullable=True),
        sa.Column("disciplines", postgresql.ARRAY(sa.Text()), nullable=True),
        sa.Column("file_path", sa.Text(), nullable=True),
        sa.Column("extracted_text", sa.Text(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(),
            server_default=sa.text("NOW()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(),
            server_default=sa.text("NOW()"),
            nullable=False,
        ),
    )

    # ------------------------------------------------------------------
    # Add source traceability columns to requirements.
    # source_document_id is nullable because most requirements may be
    # manually entered (source_type = 'Manual Entry') with no document.
    # ------------------------------------------------------------------
    op.add_column(
        "requirements",
        sa.Column(
            "source_document_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("source_documents.id", ondelete="SET NULL"),
            nullable=True,
        ),
    )
    op.add_column(
        "requirements",
        sa.Column("source_clause", sa.Text(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("requirements", "source_clause")
    op.drop_column("requirements", "source_document_id")
    op.drop_table("source_documents")
