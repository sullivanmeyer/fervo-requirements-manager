"""Saved filters

Revision ID: 006
Revises: 005
Create Date: 2026-04-07

Adds the saved_filters table so users can name and recall filter
configurations on the requirements table.
filter_config is stored as JSONB — a flexible key-value blob that can
hold any combination of filter fields without needing a column per filter.
Think of it like saving a named search: the shape of the search may evolve
over time, and JSONB lets us add new filter types without another migration.
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "006"
down_revision = "005"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "saved_filters",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
            nullable=False,
        ),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column(
            "filter_config",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
            server_default="{}",
        ),
        sa.Column("user_name", sa.Text(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(),
            server_default=sa.text("NOW()"),
            nullable=False,
        ),
    )


def downgrade() -> None:
    op.drop_table("saved_filters")
