"""021_decomposition_status — track Gemini decomposition state on source_documents

Adds two columns to source_documents so the frontend can poll decomposition
progress directly instead of counting blocks:

  decomposition_status  TEXT  NOT NULL  DEFAULT 'idle'
      Values: 'idle' | 'processing' | 'complete' | 'failed'

  decomposition_error   TEXT  NULLABLE
      Populated with the exception message when status = 'failed'.

Revision ID: 021
Revises: 020
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "021"
down_revision = "020"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "source_documents",
        sa.Column(
            "decomposition_status",
            sa.Text,
            nullable=False,
            server_default="idle",
        ),
    )
    op.add_column(
        "source_documents",
        sa.Column(
            "decomposition_error",
            sa.Text,
            nullable=True,
        ),
    )


def downgrade() -> None:
    op.drop_column("source_documents", "decomposition_error")
    op.drop_column("source_documents", "decomposition_status")
