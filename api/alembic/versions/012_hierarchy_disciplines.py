"""Add applicable_disciplines to hierarchy_nodes; seed defaults for known Geoblock nodes

Revision ID: 012
Revises: 011
Create Date: 2026-04-10
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "012"
down_revision = "011"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "hierarchy_nodes",
        sa.Column(
            "applicable_disciplines",
            postgresql.ARRAY(sa.Text()),
            nullable=True,
        ),
    )

    # Seed default discipline tags based on node names found in a typical Geoblock
    # hierarchy.  Nodes that don't match any pattern are left NULL, which means
    # "applicable to all disciplines" in the gap analysis logic.
    op.execute(sa.text("""
        UPDATE hierarchy_nodes SET applicable_disciplines = ARRAY['Mechanical','Process']
        WHERE name ILIKE '%air-cooled%' OR name ILIKE '%ACC%' OR name ILIKE '%recuperator%'
           OR name ILIKE '%superheater%' OR name ILIKE '%heat exchanger%'
           OR name ILIKE '%tube bundle%'
    """))
    op.execute(sa.text("""
        UPDATE hierarchy_nodes SET applicable_disciplines = ARRAY['Mechanical']
        WHERE name ILIKE '%feed pump%' OR name ILIKE '%pump%motor%'
           OR name ILIKE '%turbogen%' OR name ILIKE '%lube oil%'
    """))
    op.execute(sa.text("""
        UPDATE hierarchy_nodes SET applicable_disciplines = ARRAY['Civil/Structural','Mechanical']
        WHERE name ILIKE '%structural steel%' OR name ILIKE '%foundation%'
           OR name ILIKE '%civil%'
    """))
    op.execute(sa.text("""
        UPDATE hierarchy_nodes SET applicable_disciplines = ARRAY['Electrical']
        WHERE name ILIKE '%e-house%' OR name ILIKE '%electrical%'
           OR name ILIKE '%switchgear%' OR name ILIKE '%transformer%'
    """))
    op.execute(sa.text("""
        UPDATE hierarchy_nodes SET applicable_disciplines = ARRAY['I&C']
        WHERE name ILIKE '%PLC%' OR name ILIKE '%SCADA%' OR name ILIKE '%control%'
           OR name ILIKE '%instrumentation%' OR name ILIKE '%I&C%'
    """))
    op.execute(sa.text("""
        UPDATE hierarchy_nodes SET applicable_disciplines = ARRAY['Fire Protection']
        WHERE name ILIKE '%fire%'
    """))


def downgrade() -> None:
    op.drop_column("hierarchy_nodes", "applicable_disciplines")
