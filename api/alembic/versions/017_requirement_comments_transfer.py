"""Add comments and superseded_by_id to requirements

Revision ID: 017
Revises: 016
Create Date: 2026-04-10
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID

revision = "017"
down_revision = "016"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Free-form working notes; distinct from rationale (formal) and change_history (system-managed)
    op.add_column(
        "requirements",
        sa.Column("comments", sa.Text, nullable=True),
    )
    # Self-referential FK: points to the new requirement that superseded this one
    op.add_column(
        "requirements",
        sa.Column(
            "superseded_by_id",
            UUID(as_uuid=True),
            sa.ForeignKey("requirements.id", ondelete="SET NULL"),
            nullable=True,
        ),
    )


def downgrade() -> None:
    op.drop_column("requirements", "superseded_by_id")
    op.drop_column("requirements", "comments")
