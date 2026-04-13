"""019_requirement_blocks — block-linked requirements (Stage 15)

Adds:
  - content_source TEXT column to requirements  (default 'manual')
  - requirement_blocks junction table           (requirement ↔ document_block)

Revision ID: 019
Revises: 018
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID

revision = "019"
down_revision = "018"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # ── content_source on requirements ──────────────────────────────────────
    op.add_column(
        "requirements",
        sa.Column(
            "content_source",
            sa.Text,
            nullable=False,
            server_default="manual",
        ),
    )

    # ── requirement_blocks junction ──────────────────────────────────────────
    op.create_table(
        "requirement_blocks",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "requirement_id",
            UUID(as_uuid=True),
            sa.ForeignKey("requirements.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "block_id",
            UUID(as_uuid=True),
            sa.ForeignKey("document_blocks.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("sort_order", sa.Integer, nullable=False, server_default="0"),
        sa.Column("created_at", sa.DateTime, nullable=False),
    )
    op.create_unique_constraint(
        "uq_requirement_blocks_req_block",
        "requirement_blocks",
        ["requirement_id", "block_id"],
    )
    op.create_index(
        "ix_requirement_blocks_requirement_id",
        "requirement_blocks",
        ["requirement_id"],
    )


def downgrade() -> None:
    op.drop_index("ix_requirement_blocks_requirement_id", table_name="requirement_blocks")
    op.drop_constraint("uq_requirement_blocks_req_block", "requirement_blocks", type_="unique")
    op.drop_table("requirement_blocks")
    op.drop_column("requirements", "content_source")
