import uuid
from datetime import datetime

from sqlalchemy import Boolean, Column, DateTime, ForeignKey, Integer, Text
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import relationship

from database import Base


class HierarchyNode(Base):
    __tablename__ = "hierarchy_nodes"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    parent_id = Column(
        UUID(as_uuid=True),
        ForeignKey("hierarchy_nodes.id", ondelete="SET NULL"),
        nullable=True,
    )
    name = Column(Text, nullable=False)
    description = Column(Text, nullable=True)
    archived = Column(Boolean, default=False, nullable=False)
    sort_order = Column(Integer, default=0, nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at = Column(
        DateTime,
        default=datetime.utcnow,
        onupdate=datetime.utcnow,
        nullable=False,
    )

    parent = relationship(
        "HierarchyNode",
        remote_side=[id],
        back_populates="children",
        foreign_keys=[parent_id],
    )
    children = relationship(
        "HierarchyNode",
        back_populates="parent",
        foreign_keys=[parent_id],
        cascade="all",
    )
