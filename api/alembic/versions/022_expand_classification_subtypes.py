"""Expand classification_subtype CHECK constraint

Revision ID: 022
Revises: 021
Create Date: 2026-04-17

Adds 'System Interface' to the Requirement subtype list and
'Technology Selection' to the Guideline subtype list.
"""
from alembic import op

revision = "022"
down_revision = "021"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.drop_constraint("ck_requirements_classification_subtype", "requirements")
    op.create_check_constraint(
        "ck_requirements_classification_subtype",
        "requirements",
        """
        classification_subtype IS NULL OR
        (classification = 'Requirement' AND classification_subtype IN
            ('Performance Requirement', 'Design Requirement', 'Derived Requirement', 'System Interface')) OR
        (classification = 'Guideline' AND classification_subtype IN
            ('Lesson Learned', 'Procedure', 'Code', 'Technology Selection'))
        """,
    )


def downgrade() -> None:
    op.drop_constraint("ck_requirements_classification_subtype", "requirements")
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
