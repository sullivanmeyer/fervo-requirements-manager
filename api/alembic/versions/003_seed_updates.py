"""Add Cape Phase I and Geoblock sites; remove All Units

Revision ID: 003
Revises: 002
Create Date: 2026-04-06
"""
from alembic import op
import sqlalchemy as sa

revision = "003"
down_revision = "002"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Add the two new sites
    op.execute(
        sa.text(
            "INSERT INTO sites (id, name) VALUES "
            "(gen_random_uuid(), 'Cape Phase I'), "
            "(gen_random_uuid(), 'Geoblock')"
        )
    )

    # Remove All Units — it doesn't correspond to a physical asset
    # First detach any junction rows so the delete isn't blocked by FK
    op.execute(
        sa.text(
            "DELETE FROM requirement_units "
            "WHERE unit_id = (SELECT id FROM units WHERE name = 'All Units')"
        )
    )
    op.execute(sa.text("DELETE FROM units WHERE name = 'All Units'"))


def downgrade() -> None:
    # Re-insert All Units at sort_order 99
    op.execute(
        sa.text(
            "INSERT INTO units (id, name, sort_order) VALUES "
            "(gen_random_uuid(), 'All Units', 99)"
        )
    )
    # Remove the two added sites
    op.execute(
        sa.text("DELETE FROM sites WHERE name IN ('Cape Phase I', 'Geoblock')")
    )
