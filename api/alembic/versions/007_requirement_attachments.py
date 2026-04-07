"""requirement_attachments table

Revision ID: 007
Revises: 006
Create Date: 2026-04-07
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import UUID

revision = "007"
down_revision = "006"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "requirement_attachments",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "requirement_id",
            UUID(as_uuid=True),
            sa.ForeignKey("requirements.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("file_name", sa.Text, nullable=False),
        sa.Column("file_path", sa.Text, nullable=False),  # MinIO object key
        sa.Column("file_size", sa.Integer, nullable=True),
        sa.Column("content_type", sa.Text, nullable=True),
        sa.Column("uploaded_by", sa.Text, nullable=True),
        sa.Column("uploaded_at", sa.DateTime, nullable=False),
    )
    op.create_index(
        "ix_requirement_attachments_requirement_id",
        "requirement_attachments",
        ["requirement_id"],
    )


def downgrade() -> None:
    op.drop_index("ix_requirement_attachments_requirement_id")
    op.drop_table("requirement_attachments")
