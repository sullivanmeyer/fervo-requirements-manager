"""Requirement traceability links and Self-Derived seed record

Revision ID: 004
Revises: 003
Create Date: 2026-04-06

Creates the requirement_links table (parent/child edges in the derivation
tree) and seeds the special SELF-000 "Self-Derived" requirement that acts
as the root of the derivation hierarchy.
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "004"
down_revision = "003"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # ------------------------------------------------------------------
    # requirement_links: directed edges in the derivation tree.
    # Each row says "child_requirement_id derives from parent_requirement_id".
    # The composite primary key also serves as the unique constraint.
    # A CHECK prevents a requirement from being linked to itself.
    # ------------------------------------------------------------------
    op.create_table(
        "requirement_links",
        sa.Column(
            "parent_requirement_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("requirements.id", ondelete="CASCADE"),
            primary_key=True,
            nullable=False,
        ),
        sa.Column(
            "child_requirement_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("requirements.id", ondelete="CASCADE"),
            primary_key=True,
            nullable=False,
        ),
        sa.Column(
            "created_at",
            sa.DateTime(),
            server_default=sa.text("NOW()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "parent_requirement_id != child_requirement_id",
            name="ck_requirement_links_no_self_loop",
        ),
    )

    # ------------------------------------------------------------------
    # Seed the SELF-000 "Self-Derived" requirement.
    # This is the root of the derivation tree — requirements with no
    # upstream source are implicitly (or explicitly) children of this node.
    # It is never editable by end users; the API blocks writes to it.
    # ------------------------------------------------------------------
    op.execute(
        sa.text(
            """
            INSERT INTO requirements (
                id, requirement_id, title, statement,
                classification, owner, source_type, status, discipline,
                created_by, created_date, created_at, updated_at
            ) VALUES (
                gen_random_uuid(),
                'SELF-000',
                'Self-Derived',
                'System placeholder. Requirements with no upstream source are '
                'implicitly children of this node in the derivation tree.',
                'Requirement', 'System', 'Manual Entry', 'Approved', 'General',
                'System', CURRENT_DATE, NOW(), NOW()
            )
            """
        )
    )


def downgrade() -> None:
    op.execute(sa.text("DELETE FROM requirements WHERE requirement_id = 'SELF-000'"))
    op.drop_table("requirement_links")
