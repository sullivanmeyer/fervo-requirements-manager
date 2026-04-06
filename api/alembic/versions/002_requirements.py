"""requirements, sites, units, and junction tables

Revision ID: 002
Revises: 001
Create Date: 2026-04-06

All enum fields are stored as Text rather than PostgreSQL native enum types
so that adding new values in future migrations requires no table lock.

Sites and units reference data are seeded inline.
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "002"
down_revision = "001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # ------------------------------------------------------------------
    # sites reference table
    # ------------------------------------------------------------------
    sites_table = op.create_table(
        "sites",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column("name", sa.Text(), nullable=False, unique=True),
    )
    op.bulk_insert(
        sites_table,
        [
            {"name": "Cape Phase II"},
            {"name": "Red"},
        ],
    )

    # ------------------------------------------------------------------
    # units reference table
    # ------------------------------------------------------------------
    units_table = op.create_table(
        "units",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column("name", sa.Text(), nullable=False, unique=True),
        sa.Column(
            "sort_order",
            sa.Integer(),
            server_default=sa.text("0"),
            nullable=False,
        ),
    )
    op.bulk_insert(
        units_table,
        [
            {"name": "ORC Unit 1", "sort_order": 1},
            {"name": "ORC Unit 2", "sort_order": 2},
            {"name": "ORC Unit 3", "sort_order": 3},
            {"name": "ORC Unit 4", "sort_order": 4},
            {"name": "ORC Unit 5", "sort_order": 5},
            {"name": "ORC Unit 6", "sort_order": 6},
            {"name": "ORC Unit 7", "sort_order": 7},
            {"name": "ORC Unit 8", "sort_order": 8},
            {"name": "All Units", "sort_order": 99},
        ],
    )

    # ------------------------------------------------------------------
    # requirements table
    # ------------------------------------------------------------------
    op.create_table(
        "requirements",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column("requirement_id", sa.Text(), nullable=False, unique=True),
        sa.Column("title", sa.Text(), nullable=False),
        sa.Column("statement", sa.Text(), nullable=False),
        # Enum fields stored as Text — valid values enforced in application layer
        sa.Column("classification", sa.Text(), nullable=False),
        sa.Column("owner", sa.Text(), nullable=False),
        sa.Column("source_type", sa.Text(), nullable=False),
        sa.Column("status", sa.Text(), nullable=False, server_default="Draft"),
        sa.Column("discipline", sa.Text(), nullable=False),
        sa.Column("created_by", sa.Text(), nullable=False),
        sa.Column("created_date", sa.Date(), nullable=False),
        sa.Column("last_modified_by", sa.Text(), nullable=True),
        sa.Column("last_modified_date", sa.Date(), nullable=True),
        sa.Column("change_history", sa.Text(), nullable=True),
        sa.Column("rationale", sa.Text(), nullable=True),
        sa.Column("verification_method", sa.Text(), nullable=True),
        sa.Column("tags", postgresql.ARRAY(sa.Text()), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(),
            server_default=sa.text("NOW()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(),
            server_default=sa.text("NOW()"),
            nullable=False,
        ),
    )

    # ------------------------------------------------------------------
    # junction tables
    # ------------------------------------------------------------------
    op.create_table(
        "requirement_hierarchy_nodes",
        sa.Column(
            "requirement_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("requirements.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column(
            "hierarchy_node_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("hierarchy_nodes.id", ondelete="CASCADE"),
            primary_key=True,
        ),
    )

    op.create_table(
        "requirement_sites",
        sa.Column(
            "requirement_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("requirements.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column(
            "site_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("sites.id", ondelete="CASCADE"),
            primary_key=True,
        ),
    )

    op.create_table(
        "requirement_units",
        sa.Column(
            "requirement_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("requirements.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column(
            "unit_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("units.id", ondelete="CASCADE"),
            primary_key=True,
        ),
    )


def downgrade() -> None:
    op.drop_table("requirement_units")
    op.drop_table("requirement_sites")
    op.drop_table("requirement_hierarchy_nodes")
    op.drop_table("requirements")
    op.drop_table("units")
    op.drop_table("sites")
