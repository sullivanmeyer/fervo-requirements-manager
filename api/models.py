import uuid
from datetime import datetime

from sqlalchemy import Boolean, CheckConstraint, Column, DateTime, Date, ForeignKey, Integer, Table, Text
from sqlalchemy.dialects.postgresql import ARRAY, UUID
from sqlalchemy.orm import backref, relationship

from database import Base


# ---------------------------------------------------------------------------
# Source documents
# ---------------------------------------------------------------------------

class SourceDocument(Base):
    __tablename__ = "source_documents"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    document_id = Column(Text, nullable=False, unique=True)
    title = Column(Text, nullable=False)
    document_type = Column(Text, nullable=False)
    revision = Column(Text, nullable=True)
    issuing_organization = Column(Text, nullable=True)
    disciplines = Column(ARRAY(Text), nullable=True)
    file_path = Column(Text, nullable=True)       # MinIO object key
    extracted_text = Column(Text, nullable=True)
    # True = auto-detected reference stub; cleared when user saves real metadata
    is_stub = Column(Boolean, default=False, nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at = Column(
        DateTime,
        default=datetime.utcnow,
        onupdate=datetime.utcnow,
        nullable=False,
    )


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
    applicable_disciplines = Column(ARRAY(Text), nullable=True)
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
    source_document_id = Column(
        UUID(as_uuid=True),
        ForeignKey("source_documents.id", ondelete="SET NULL"),
        nullable=True,
    )
    source_clause = Column(Text, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at = Column(
        DateTime,
        default=datetime.utcnow,
        onupdate=datetime.utcnow,
        nullable=False,
    )

    source_document = relationship("SourceDocument", lazy="joined")

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


# ---------------------------------------------------------------------------
# Saved filters
# ---------------------------------------------------------------------------

class SavedFilter(Base):
    __tablename__ = "saved_filters"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    name = Column(Text, nullable=False)
    filter_config = Column(Text, nullable=False, default="{}")  # stored as JSON string
    user_name = Column(Text, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)


# ---------------------------------------------------------------------------
# Requirement attachments
# ---------------------------------------------------------------------------

class RequirementAttachment(Base):
    __tablename__ = "requirement_attachments"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    requirement_id = Column(
        UUID(as_uuid=True),
        ForeignKey("requirements.id", ondelete="CASCADE"),
        nullable=False,
    )
    file_name = Column(Text, nullable=False)
    file_path = Column(Text, nullable=False)   # MinIO object key (UUID string)
    file_size = Column(Integer, nullable=True)
    content_type = Column(Text, nullable=True)
    uploaded_by = Column(Text, nullable=True)
    uploaded_at = Column(DateTime, nullable=False, default=datetime.utcnow)


# ---------------------------------------------------------------------------
# Document blocks (LLM decomposition of source document PDF)
# ---------------------------------------------------------------------------

class DocumentBlock(Base):
    __tablename__ = "document_blocks"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    source_document_id = Column(
        UUID(as_uuid=True),
        ForeignKey("source_documents.id", ondelete="CASCADE"),
        nullable=False,
    )
    parent_block_id = Column(
        UUID(as_uuid=True),
        ForeignKey("document_blocks.id", ondelete="SET NULL"),
        nullable=True,
    )
    clause_number = Column(Text, nullable=True)
    heading = Column(Text, nullable=True)
    content = Column(Text, nullable=False)
    # heading / requirement_clause / table_row / informational / boilerplate
    block_type = Column(Text, nullable=False)
    sort_order = Column(Integer, default=0, nullable=False)
    depth = Column(Integer, default=0, nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)

    children = relationship(
        "DocumentBlock",
        foreign_keys=[parent_block_id],
        backref=backref("parent", remote_side="DocumentBlock.id"),
        lazy="select",
    )


# ---------------------------------------------------------------------------
# Extraction candidates (LLM-proposed requirements pending user review)
# ---------------------------------------------------------------------------

class ExtractionCandidate(Base):
    __tablename__ = "extraction_candidates"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    source_document_id = Column(
        UUID(as_uuid=True),
        ForeignKey("source_documents.id", ondelete="CASCADE"),
        nullable=False,
    )
    source_block_id = Column(
        UUID(as_uuid=True),
        ForeignKey("document_blocks.id", ondelete="SET NULL"),
        nullable=True,
    )
    title = Column(Text, nullable=False)
    statement = Column(Text, nullable=False)
    source_clause = Column(Text, nullable=True)
    suggested_classification = Column(Text, nullable=True)   # Requirement / Guideline
    suggested_discipline = Column(Text, nullable=True)
    # Pending / Accepted / Rejected / Edited
    status = Column(Text, nullable=False, default="Pending")
    accepted_requirement_id = Column(
        UUID(as_uuid=True),
        ForeignKey("requirements.id", ondelete="SET NULL"),
        nullable=True,
    )
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)


# ---------------------------------------------------------------------------
# Document references (inter-document dependency graph)
# ---------------------------------------------------------------------------

class DocumentReference(Base):
    """
    A directed edge: source_document references referenced_document.
    One row means: "source_document cites / depends on referenced_document."
    """
    __tablename__ = "document_references"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    source_document_id = Column(
        UUID(as_uuid=True),
        ForeignKey("source_documents.id", ondelete="CASCADE"),
        nullable=False,
    )
    referenced_document_id = Column(
        UUID(as_uuid=True),
        ForeignKey("source_documents.id", ondelete="CASCADE"),
        nullable=False,
    )
    # Optional phrase that triggered this reference, e.g. "per API 661 §5.1"
    reference_context = Column(Text, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)

    source_document = relationship(
        "SourceDocument",
        foreign_keys=[source_document_id],
        backref=backref("outgoing_references", cascade="all, delete-orphan"),
    )
    referenced_document = relationship(
        "SourceDocument",
        foreign_keys=[referenced_document_id],
        backref=backref("incoming_references", cascade="all, delete-orphan"),
    )


# ---------------------------------------------------------------------------
# Requirement traceability links
# ---------------------------------------------------------------------------

class RequirementLink(Base):
    """
    A directed edge in the requirement derivation tree.
    One row means: child_requirement derives from parent_requirement.
    The composite primary key also enforces uniqueness on the pair.
    """
    __tablename__ = "requirement_links"

    parent_requirement_id = Column(
        UUID(as_uuid=True),
        ForeignKey("requirements.id", ondelete="CASCADE"),
        primary_key=True,
        nullable=False,
    )
    child_requirement_id = Column(
        UUID(as_uuid=True),
        ForeignKey("requirements.id", ondelete="CASCADE"),
        primary_key=True,
        nullable=False,
    )
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)

    __table_args__ = (
        CheckConstraint(
            "parent_requirement_id != child_requirement_id",
            name="ck_requirement_links_no_self_loop",
        ),
    )


# ---------------------------------------------------------------------------
# Conflict records
# ---------------------------------------------------------------------------

conflict_record_requirements = Table(
    "conflict_record_requirements",
    Base.metadata,
    Column(
        "conflict_record_id",
        UUID(as_uuid=True),
        ForeignKey("conflict_records.id", ondelete="CASCADE"),
        primary_key=True,
    ),
    Column(
        "requirement_id",
        UUID(as_uuid=True),
        ForeignKey("requirements.id", ondelete="CASCADE"),
        primary_key=True,
    ),
)


class ConflictRecord(Base):
    """
    A flagged contradiction between two or more requirements.
    Lifecycle: Open → Under Discussion → Resolved / Deferred.
    Soft-deleted via archived flag (never physically removed).
    """
    __tablename__ = "conflict_records"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    description = Column(Text, nullable=False)
    # Open / Under Discussion / Resolved / Deferred
    status = Column(Text, nullable=False, default="Open")
    resolution_notes = Column(Text, nullable=True)
    created_by = Column(Text, nullable=False)
    archived = Column(Boolean, default=False, nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at = Column(
        DateTime,
        default=datetime.utcnow,
        onupdate=datetime.utcnow,
        nullable=False,
    )

    requirements = relationship(
        "Requirement",
        secondary=conflict_record_requirements,
        lazy="joined",
    )
