"""Add conflict_records and conflict_record_requirements tables

Revision ID: 011
Revises: 010
Create Date: 2026-04-09

A conflict record flags two or more requirements as contradicting each other.
It has a lifecycle: Open → Under Discussion → Resolved / Deferred.
The junction table supports linking any number of requirements to one record.
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import UUID

revision = "011"
down_revision = "010"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # -------------------------------------------------------------------------
    # conflict_records
    # -------------------------------------------------------------------------
    op.create_table(
        "conflict_records",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column("description", sa.Text, nullable=False),
        sa.Column(
            "status",
            sa.Text,
            nullable=False,
            server_default="Open",
        ),
        sa.Column("resolution_notes", sa.Text, nullable=True),
        sa.Column("created_by", sa.Text, nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime,
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime,
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.Column(
            "archived",
            sa.Boolean,
            nullable=False,
            server_default="false",
        ),
    )
    op.create_index(
        "ix_conflict_records_status",
        "conflict_records",
        ["status"],
    )

    # -------------------------------------------------------------------------
    # conflict_record_requirements  (junction)
    # -------------------------------------------------------------------------
    op.create_table(
        "conflict_record_requirements",
        sa.Column(
            "conflict_record_id",
            UUID(as_uuid=True),
            sa.ForeignKey("conflict_records.id", ondelete="CASCADE"),
            primary_key=True,
            nullable=False,
        ),
        sa.Column(
            "requirement_id",
            UUID(as_uuid=True),
            sa.ForeignKey("requirements.id", ondelete="CASCADE"),
            primary_key=True,
            nullable=False,
        ),
    )
    op.create_index(
        "ix_crr_requirement_id",
        "conflict_record_requirements",
        ["requirement_id"],
    )


def downgrade() -> None:
    op.drop_index("ix_crr_requirement_id")
    op.drop_table("conflict_record_requirements")
    op.drop_index("ix_conflict_records_status")
    op.drop_table("conflict_records")
