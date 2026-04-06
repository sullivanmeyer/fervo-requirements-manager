import uuid
from datetime import datetime

from sqlalchemy import Boolean, Column, DateTime, Date, ForeignKey, Integer, Table, Text
from sqlalchemy.dialects.postgresql import ARRAY, UUID
from sqlalchemy.orm import relationship

from database import Base


# ---------------------------------------------------------------------------
# Hierarchy
# ---------------------------------------------------------------------------

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


# ---------------------------------------------------------------------------
# Junction tables (defined before Requirement so relationships can reference them)
# ---------------------------------------------------------------------------

requirement_hierarchy_nodes = Table(
    "requirement_hierarchy_nodes",
    Base.metadata,
    Column(
        "requirement_id",
        UUID(as_uuid=True),
        ForeignKey("requirements.id", ondelete="CASCADE"),
        primary_key=True,
    ),
    Column(
        "hierarchy_node_id",
        UUID(as_uuid=True),
        ForeignKey("hierarchy_nodes.id", ondelete="CASCADE"),
        primary_key=True,
    ),
)

requirement_sites = Table(
    "requirement_sites",
    Base.metadata,
    Column(
        "requirement_id",
        UUID(as_uuid=True),
        ForeignKey("requirements.id", ondelete="CASCADE"),
        primary_key=True,
    ),
    Column(
        "site_id",
        UUID(as_uuid=True),
        ForeignKey("sites.id", ondelete="CASCADE"),
        primary_key=True,
    ),
)

requirement_units = Table(
    "requirement_units",
    Base.metadata,
    Column(
        "requirement_id",
        UUID(as_uuid=True),
        ForeignKey("requirements.id", ondelete="CASCADE"),
        primary_key=True,
    ),
    Column(
        "unit_id",
        UUID(as_uuid=True),
        ForeignKey("units.id", ondelete="CASCADE"),
        primary_key=True,
    ),
)


# ---------------------------------------------------------------------------
# Reference tables
# ---------------------------------------------------------------------------

class Site(Base):
    __tablename__ = "sites"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    name = Column(Text, nullable=False, unique=True)


class Unit(Base):
    __tablename__ = "units"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    name = Column(Text, nullable=False, unique=True)
    sort_order = Column(Integer, default=0, nullable=False)


# ---------------------------------------------------------------------------
# Requirements
# ---------------------------------------------------------------------------

class Requirement(Base):
    __tablename__ = "requirements"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    requirement_id = Column(Text, nullable=False, unique=True)
    title = Column(Text, nullable=False)
    statement = Column(Text, nullable=False)
    classification = Column(Text, nullable=False)
    owner = Column(Text, nullable=False)
    source_type = Column(Text, nullable=False)
    status = Column(Text, nullable=False, default="Draft")
    discipline = Column(Text, nullable=False)
    created_by = Column(Text, nullable=False)
    created_date = Column(Date, nullable=False)
    last_modified_by = Column(Text, nullable=True)
    last_modified_date = Column(Date, nullable=True)
    change_history = Column(Text, nullable=True)
    rationale = Column(Text, nullable=True)
    verification_method = Column(Text, nullable=True)
    tags = Column(ARRAY(Text), nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at = Column(
        DateTime,
        default=datetime.utcnow,
        onupdate=datetime.utcnow,
        nullable=False,
    )

    hierarchy_nodes = relationship(
        "HierarchyNode",
        secondary=requirement_hierarchy_nodes,
        lazy="joined",
    )
    sites = relationship(
        "Site",
        secondary=requirement_sites,
        lazy="joined",
    )
    units = relationship(
        "Unit",
        secondary=requirement_units,
        lazy="joined",
    )
