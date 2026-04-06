from __future__ import annotations

from datetime import date
from typing import List, Optional
from uuid import UUID

from pydantic import BaseModel, field_validator

# ---------------------------------------------------------------------------
# Allowed values for enum fields
# ---------------------------------------------------------------------------

CLASSIFICATIONS = {"Requirement", "Guideline"}
SOURCE_TYPES = {"Manual Entry", "Derived from Document"}
STATUSES = {"Draft", "Under Review", "Approved", "Superseded", "Withdrawn"}
DISCIPLINES = {
    "Mechanical",
    "Electrical",
    "I&C",
    "Civil/Structural",
    "Process",
    "Fire Protection",
    "General",
}
VERIFICATION_METHODS = {
    "Analysis",
    "Inspection",
    "Test",
    "Demonstration",
    "Review of Record",
}


# ---------------------------------------------------------------------------
# Hierarchy schemas
# ---------------------------------------------------------------------------

class HierarchyNodeCreate(BaseModel):
    name: str
    description: Optional[str] = None
    parent_id: Optional[UUID] = None
    sort_order: int = 0


class HierarchyNodeUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    parent_id: Optional[UUID] = None
    sort_order: Optional[int] = None


# ---------------------------------------------------------------------------
# Requirement schemas
# ---------------------------------------------------------------------------

class RequirementCreate(BaseModel):
    title: str
    statement: str
    classification: str
    owner: str
    source_type: str
    status: str = "Draft"
    discipline: str
    created_by: str
    created_date: date
    last_modified_by: Optional[str] = None
    last_modified_date: Optional[date] = None
    change_history: Optional[str] = None
    rationale: Optional[str] = None
    verification_method: Optional[str] = None
    tags: Optional[List[str]] = None
    hierarchy_node_ids: List[UUID] = []
    site_ids: List[UUID] = []
    unit_ids: List[UUID] = []

    @field_validator("classification")
    @classmethod
    def validate_classification(cls, v: str) -> str:
        if v not in CLASSIFICATIONS:
            raise ValueError(f"Must be one of: {', '.join(sorted(CLASSIFICATIONS))}")
        return v

    @field_validator("source_type")
    @classmethod
    def validate_source_type(cls, v: str) -> str:
        if v not in SOURCE_TYPES:
            raise ValueError(f"Must be one of: {', '.join(sorted(SOURCE_TYPES))}")
        return v

    @field_validator("status")
    @classmethod
    def validate_status(cls, v: str) -> str:
        if v not in STATUSES:
            raise ValueError(f"Must be one of: {', '.join(sorted(STATUSES))}")
        return v

    @field_validator("discipline")
    @classmethod
    def validate_discipline(cls, v: str) -> str:
        if v not in DISCIPLINES:
            raise ValueError(f"Must be one of: {', '.join(sorted(DISCIPLINES))}")
        return v

    @field_validator("verification_method")
    @classmethod
    def validate_verification_method(cls, v: Optional[str]) -> Optional[str]:
        if v is not None and v not in VERIFICATION_METHODS:
            raise ValueError(
                f"Must be one of: {', '.join(sorted(VERIFICATION_METHODS))}"
            )
        return v


class RequirementUpdate(BaseModel):
    title: Optional[str] = None
    statement: Optional[str] = None
    classification: Optional[str] = None
    owner: Optional[str] = None
    source_type: Optional[str] = None
    status: Optional[str] = None
    discipline: Optional[str] = None
    created_by: Optional[str] = None
    created_date: Optional[date] = None
    last_modified_by: Optional[str] = None
    last_modified_date: Optional[date] = None
    change_history: Optional[str] = None
    rationale: Optional[str] = None
    verification_method: Optional[str] = None
    tags: Optional[List[str]] = None
    hierarchy_node_ids: Optional[List[UUID]] = None
    site_ids: Optional[List[UUID]] = None
    unit_ids: Optional[List[UUID]] = None

    @field_validator("classification")
    @classmethod
    def validate_classification(cls, v: Optional[str]) -> Optional[str]:
        if v is not None and v not in CLASSIFICATIONS:
            raise ValueError(f"Must be one of: {', '.join(sorted(CLASSIFICATIONS))}")
        return v

    @field_validator("status")
    @classmethod
    def validate_status(cls, v: Optional[str]) -> Optional[str]:
        if v is not None and v not in STATUSES:
            raise ValueError(f"Must be one of: {', '.join(sorted(STATUSES))}")
        return v

    @field_validator("discipline")
    @classmethod
    def validate_discipline(cls, v: Optional[str]) -> Optional[str]:
        if v is not None and v not in DISCIPLINES:
            raise ValueError(f"Must be one of: {', '.join(sorted(DISCIPLINES))}")
        return v

    @field_validator("verification_method")
    @classmethod
    def validate_verification_method(cls, v: Optional[str]) -> Optional[str]:
        if v is not None and v not in VERIFICATION_METHODS:
            raise ValueError(
                f"Must be one of: {', '.join(sorted(VERIFICATION_METHODS))}"
            )
        return v
