"""020_requirement_archive — soft-delete for requirements (Stage 15 follow-on)

Adds archived BOOLEAN column (default false) to requirements.
Archived requirements are hidden from list/filter views but all traceability
links, block linkages, and history are preserved.

Revision ID: 020
Revises: 019
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "020"
down_revision = "019"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "requirements",
        sa.Column(
            "archived",
            sa.Boolean,
            nullable=False,
            server_default=sa.text("false"),
        ),
    )
    op.create_index(
        "ix_requirements_archived",
        "requirements",
        ["archived"],
    )


def downgrade() -> None:
    op.drop_index("ix_requirements_archived", table_name="requirements")
    op.drop_column("requirements", "archived")
