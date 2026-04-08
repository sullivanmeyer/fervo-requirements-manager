"""Add is_stub flag to source_documents

Revision ID: 010
Revises: 009
Create Date: 2026-04-08

is_stub = True means the document was auto-detected as a reference during
Gemini decomposition of another document.  It has minimal metadata (just the
detected name) and no PDF.  The flag is cleared when a user saves real
metadata via the edit form, promoting the stub to a full registry entry.
"""
from alembic import op
import sqlalchemy as sa

revision = "010"
down_revision = "009"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "source_documents",
        sa.Column(
            "is_stub",
            sa.Boolean,
            nullable=False,
            server_default="false",
        ),
    )


def downgrade() -> None:
    op.drop_column("source_documents", "is_stub")
