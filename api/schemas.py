from __future__ import annotations

from typing import Optional
from uuid import UUID

from pydantic import BaseModel


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
