"""Add archived flag to source_documents

Revision ID: 016
Revises: 015
Create Date: 2026-04-10

Adds a soft-delete flag to source documents consistent with the existing
archived boolean on hierarchy_nodes.  Archived documents are hidden from
active workflows (list views, source doc picker, document network) but
retained in the database so that requirement traceability links remain
intact.  The flag is toggled via PATCH /source-documents/{id}/archive
and can be reversed (un-archived) using the same endpoint.
"""
from alembic import op
import sqlalchemy as sa

revision = "016"
down_revision = "015"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "source_documents",
        sa.Column(
            "archived",
            sa.Boolean,
            server_default=sa.text("false"),
            nullable=False,
        ),
    )


def downgrade() -> None:
    op.drop_column("source_documents", "archived")
