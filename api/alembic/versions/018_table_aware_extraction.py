"""Add table_data JSONB to document_blocks for table-aware extraction pipeline.

Revision ID: 018
Revises: 017
Create Date: 2026-04-13
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB

revision = "018"
down_revision = "017"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Store structured table data for table_block type blocks
    # Schema: {caption: str|null, headers: [str], rows: [[str]], context_note: str|null}
    op.add_column(
        "document_blocks",
        sa.Column("table_data", JSONB, nullable=True),
    )


def downgrade() -> None:
    op.drop_column("document_blocks", "table_data")
