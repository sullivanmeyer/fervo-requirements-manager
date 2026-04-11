"""Add classification_subtype to requirements and extraction candidates

Revision ID: 014
Revises: 013
Create Date: 2026-04-10

classification_subtype is optional (nullable) and must be consistent with
classification when set:
  Requirement → Performance Requirement | Design Requirement | Derived Requirement
  Guideline   → Lesson Learned | Procedure | Code

The CHECK constraint is enforced at the DB level; Pydantic also validates it.
suggested_classification_subtype on extraction_candidates mirrors the same
vocabulary for LLM-proposed subtypes pending user review.
"""
from alembic import op
import sqlalchemy as sa

revision = "014"
down_revision = "013"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("requirements", sa.Column("classification_subtype", sa.Text, nullable=True))
    op.create_check_constraint(
        "ck_requirements_classification_subtype",
        "requirements",
        """
        classification_subtype IS NULL OR
        (classification = 'Requirement' AND classification_subtype IN
            ('Performance Requirement', 'Design Requirement', 'Derived Requirement')) OR
        (classification = 'Guideline' AND classification_subtype IN
            ('Lesson Learned', 'Procedure', 'Code'))
        """,
    )
    op.add_column(
        "extraction_candidates",
        sa.Column("suggested_classification_subtype", sa.Text, nullable=True),
    )


def downgrade() -> None:
    op.drop_constraint("ck_requirements_classification_subtype", "requirements")
    op.drop_column("requirements", "classification_subtype")
    op.drop_column("extraction_candidates", "suggested_classification_subtype")
