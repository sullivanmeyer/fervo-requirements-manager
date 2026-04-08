# Phase 1 MVP — Staged Implementation Checklist
# Requirements Management Application
# Last updated: April 2026

This file tracks Claude Code's progress through the Phase 1 MVP build.
Check each box as the item is implemented and verified.
Refer to the PRD (v0.5) for full field definitions and business logic.

---

## Stage 1 — Data Model + System Hierarchy CRUD

### Infrastructure (Docker Compose)
- [x] `docker-compose.yml` with four services: `db` (PostgreSQL 16), `api` (FastAPI), `web` (React + Vite), `minio` (MinIO S3-compatible storage)
- [x] PostgreSQL container with named volume for data persistence
- [x] FastAPI container with Dockerfile, hot-reload via volume mount
- [x] React container with Dockerfile, hot-reload via volume mount, proxies API calls to FastAPI
- [x] MinIO container (idle until Stage 4, but wired into network and env vars)
- [x] `.env` file with DB credentials, API port, MinIO credentials; `.env.example` checked into repo
- [x] `Makefile` with convenience commands: `make up`, `make down`, `make seed`, `make logs`, `make clean`
- [ ] App starts with `docker compose up` — frontend at localhost:3000, API at localhost:8000, MinIO console at localhost:9001

### Backend — Database & Migrations
- [x] Alembic configured for migration management
- [x] Initial migration: `hierarchy_nodes` table (id UUID, parent_id nullable self-ref, name text, description text nullable, archived boolean default false, sort_order integer, created_at, updated_at)
- [x] Migrations run automatically on API container startup (`alembic upgrade head`)

### Backend — Seed Data
- [x] Seed script (`scripts/seed_hierarchy.py`) populates the Geoblock default hierarchy:
  - [x] Geoblock Powerblock (root)
    - [x] BrineTransfer Module → Wellpad, Production Well Gathering Piping & Valves, Injection Pumps/VFDs/Motors, Injection Piping & Valves
    - [x] ThermalFlux Module → Preheater, Vaporizer, Superheater, ThermalFlux Foundations & Valves
    - [x] HeatRejection Module → ACC (with children: Tube Bundles, Induced-Draft Fans & Motors, Headers & Nozzles, Structural Steel, VFDs), Recuperator, Feed Pumps & Feed Pump Motors, NCG Skid Connection, Cold-Side WF Piping & Valves, HeatRejection Structural Steel & Foundations, Plot Plan / Plant Layout
    - [x] Turbogen Module → Turboexpander, Generator, GCB & Protection Relay, Oil Skid, Cooling Water Skid, Turbine Drain & Bypass Systems, Turbogen Foundations/Piping/Valves
    - [x] E-House Module → 13.8kV Bus Duct, Unit Auxiliary Transformers, MV Switchgear, Power Cables & Wiring, Junction Boxes & Breakers, E-House Building
    - [x] Power Export Module → Substation, Step-Up Transformer (HV Side), Transmission Line, Protection & Relay Systems, Power Export Civil & Structural
    - [x] Control System Module → PLC Architecture, HMI, I/O & Control Wiring, Instrumentation, Control Narratives
    - [x] Utilities Module → Firewater System, Instrument Air / Compressed Air, CCTV, Weather Station, Permanent Buildings
- [x] Seed script is idempotent (safe to run multiple times)
- [x] `make seed` runs the seed script inside the API container

### Backend — API Endpoints
- [x] `GET /api/hierarchy` — returns full tree as nested JSON via recursive CTE
- [x] `POST /api/hierarchy` — create a new node (accepts parent_id, name, description)
- [x] `PUT /api/hierarchy/{id}` — update node (rename, reparent, reorder)
- [x] `PATCH /api/hierarchy/{id}/archive` — archive a node (set archived=true)

### Frontend — Hierarchy Tree
- [x] Collapsible tree view showing all non-archived hierarchy nodes
- [x] Expand/collapse toggles on nodes with children
- [x] Click a node to select it; side panel shows name and description
- [x] "Add Node" button creates a child of selected node (or root if none selected)
- [x] Rename capability (inline edit or modal)
- [x] Reparent capability (drag-and-drop or "Move To" dropdown)
- [x] Archive button on selected node
- [x] User identity: text input at top of page for display name, persisted to localStorage

### Stage 1 Verification
- [x] `docker compose up` starts all services without errors
- [x] Geoblock hierarchy visible on page load at localhost:3000
- [x] Can add a new node, rename it, reparent it, archive it
- [x] Changes persist across page refresh
- [x] Changes persist across `docker compose down` / `docker compose up` cycle

---

## Stage 2 — Requirement CRUD (Core Fields Only)

### Backend — Database
- [x] Alembic migration: `requirements` table with columns:
  - [x] id (UUID), requirement_id (auto-generated string), title, statement
  - [x] classification (enum: Requirement, Guideline)
  - [x] owner (text), source_type (enum: Manual Entry, Derived from Document)
  - [x] status (enum: Draft, Under Review, Approved, Superseded, Withdrawn)
  - [x] discipline (enum: Mechanical, Electrical, I&C, Civil/Structural, Process, Fire Protection, General)
  - [x] created_by (text), created_date (date), last_modified_by (text), last_modified_date (date)
  - [x] change_history (text, nullable), rationale (text, nullable)
  - [x] verification_method (enum nullable: Analysis, Inspection, Test, Demonstration, Review of Record)
  - [x] tags (text array, nullable)
- [x] Alembic migration: `requirement_hierarchy_nodes` junction table (requirement_id, hierarchy_node_id)
- [x] Alembic migration: `sites` reference table, seeded with Cape Phase II and Red
- [x] Alembic migration: `units` reference table, seeded with ORC Unit 1–8 and All Units
- [x] Alembic migration: `requirement_sites` junction table
- [x] Alembic migration: `requirement_units` junction table
- [x] Auto-generation logic for requirement_id: [DISCIPLINE_PREFIX]-[ZERO_PADDED_SEQ] (e.g., MECH-001)

### Backend — API Endpoints
- [x] `GET /api/requirements` — list with pagination (page, page_size params), returns lightweight records for table view
- [x] `GET /api/requirements/{id}` — full detail for single requirement including all fields
- [x] `POST /api/requirements` — create requirement, validates required fields, auto-generates requirement_id
- [x] `PUT /api/requirements/{id}` — update requirement, validates changes
- [x] `GET /api/sites` — list all sites
- [x] `GET /api/units` — list all units

### Frontend — Requirements Table View
- [x] Table with requirements as rows, fields as columns
- [x] Default visible columns: Requirement ID, Title, Classification, Owner, Status, Discipline, Hierarchy Nodes, Site, Applicable Units, Created By, Created Date
- [x] Column show/hide toggle
- [x] Click column header to sort ascending/descending
- [x] Click row to open detail view
- [x] "Create Requirement" button opens blank detail form

### Frontend — Requirement Detail/Edit View
- [x] Form showing all requirement fields
- [x] Hierarchy Nodes: multi-select tree picker (check nodes from hierarchy)
- [x] Site: multi-select dropdown
- [x] Applicable Units: multi-select dropdown
- [x] Owner defaults to current display name
- [x] Created By and Created Date auto-fill on creation but remain editable
- [x] Save button commits changes via API
- [x] Cancel button returns to table view without saving

### Stage 2 Verification
- [x] Create requirement "ACC Design Pressure" — Discipline=Mechanical, assign to ACC node and ACC Headers & Nozzles, Site=Cape Phase II, Units=All Units
- [x] Verify it appears in table with generated ID like MECH-001
- [x] Edit it: change Status from Draft to Under Review — verify table updates
- [x] Create second requirement with Discipline=Electrical — verify it gets ELEC-001
- [x] Verify hierarchy nodes show correctly as tags/list in the table column

---

## Stage 3 — Traceability Links (Parent/Child Requirements)

### Backend — Database
- [x] Alembic migration: `requirement_links` table (parent_requirement_id UUID FK, child_requirement_id UUID FK, created_at). Unique constraint on the pair.
- [x] System-seeded "Self-Derived" requirement record (special ID like SELF-000, not editable by users)

### Backend — Logic
- [x] Cycle detection: before inserting a link, walk ancestor chain of proposed parent to confirm proposed child is not already an ancestor. Reject with clear error if cycle detected.
- [x] `POST /api/requirement-links` — add a parent/child link
- [x] `DELETE /api/requirement-links` — remove a parent/child link
- [x] `GET /api/requirements/{id}/ancestors` — recursive upward traversal
- [x] `GET /api/requirements/{id}/descendants` — recursive downward traversal
- [x] Update `GET /api/requirements/{id}` to include parent_requirements and child_requirements lists

### Frontend — Requirement Detail/Edit View Updates
- [x] Parent Requirement(s) field: searchable multi-select dropdown listing all requirements. Defaults to "Self-Derived" if nothing selected.
- [x] Child Requirement(s) field: read-only auto-populated list, each child is a clickable link
- [x] "Add Child" button: creates new requirement pre-populated with current requirement as parent
- [x] Bi-directional sync: adding B as child of A shows A as parent of B, and vice versa

### Frontend — Requirement Derivation Tree View
- [x] New page/tab: navigable collapsible tree of requirements by parent/child links
- [x] Each tree node shows: Requirement ID, Title, Classification, Status, Owner, Hierarchy Nodes (as tags)
- [x] Click a node to open its detail view
- [x] "View in Tree" button on detail view opens tree centered on that requirement
- [x] Tree rooted at Self-Derived shows full derivation hierarchy

### Stage 3 Verification
- [x] Create three requirements forming a chain: plant-level → system-level → component-level
- [x] Set parent/child links between them
- [x] Open tree view — verify three-node chain is visible
- [x] Click component-level requirement — verify Parent Requirements shows system-level one
- [x] Click "View in Tree" — verify tree shows full chain from Self-Derived down
- [x] Attempt to create a cycle (make component-level a parent of plant-level) — verify app rejects it with clear error
- [x] Add a child from the detail view — verify new requirement is pre-linked

---

## Stage 4 — Source Document Registry + PDF Upload

### Backend — Database
- [x] Alembic migration: `source_documents` table (id UUID, document_id text, title, document_type enum, revision text, issuing_organization text, disciplines text array, file_path text nullable, extracted_text text nullable, created_at, updated_at)
- [x] Alembic migration: add `source_document_id` (nullable FK) and `source_clause` (text nullable) columns to `requirements` table

### Backend — File Storage
- [x] MinIO bucket creation on startup (e.g., bucket named "documents")
- [x] `POST /api/source-documents/{id}/upload` — accepts PDF, stores in MinIO, returns S3 key
- [x] `GET /api/source-documents/{id}/download` — returns the PDF file
- [x] PDF text extraction using pymupdf or pdfplumber — extracted text stored in source_documents.extracted_text

### Backend — API Endpoints
- [x] `GET /api/source-documents` — list all source documents
- [x] `GET /api/source-documents/{id}` — full detail including extracted text and list of linked requirements
- [x] `POST /api/source-documents` — create document record
- [x] `PUT /api/source-documents/{id}` — update document metadata

### Frontend — Source Document Registry
- [x] New page: table of all source documents (Document ID, Title, Type, Revision, Issuing Org)
- [x] "Create" button to add new document record
- [x] File upload widget to attach a PDF to a document record

### Frontend — Document Detail View
- [x] Shows document metadata
- [x] Embedded PDF viewer (iframe or react-pdf)
- [x] Extracted text display panel
- [x] List of all requirements derived from this document (filtered from requirements table)
- [x] "Create Requirement from Selection": user highlights text in extracted text panel, clicks button, new requirement form opens with Statement pre-populated, Source Type = Derived from Document, Source Document pre-linked

### Frontend — Requirement Detail/Edit View Updates
- [x] Source Document field: searchable dropdown from document registry
- [x] Source Clause field: free text
- [x] Source Document required when Source Type = "Derived from Document"

### Stage 4 Verification
- [x] Register source document: "API 661, 7th Edition" — Type=Code/Standard, Issuing Org=API
- [x] Upload a test PDF — verify it renders in embedded viewer
- [x] Verify extracted text is visible in text panel
- [x] Highlight a passage, click "Create Requirement from Selection"
- [x] Verify new requirement form has Statement pre-populated, Source Type and Source Document pre-linked
- [x] Save requirement — verify it appears in the document's "derived requirements" list
- [x] Verify Source Document and Source Clause fields work on the requirement detail view

---

## Stage 5 — Table Filtering + Saved Filters

### Backend — Database
- [x] Alembic migration: `saved_filters` table (id UUID, name text, filter_config JSONB, user_name text, created_at)

### Backend — API Endpoints
- [x] Extend `GET /api/requirements` to accept filter parameters:
  - [x] status (multi-select)
  - [x] classification (single select)
  - [x] discipline (multi-select)
  - [x] owner (text search / partial match)
  - [x] hierarchy_node_id with include_descendants boolean
  - [x] site (multi-select)
  - [x] units (multi-select)
  - [x] source_type (single select)
  - [x] source_document_id (single select)
  - [x] tags (multi-select / partial match)
  - [x] created_date range (from/to)
  - [x] modified_date range (from/to)
- [x] `POST /api/saved-filters` — create saved filter
- [x] `GET /api/saved-filters` — list saved filters (optionally filtered by user_name)
- [x] `DELETE /api/saved-filters/{id}` — delete saved filter

### Frontend — Filter Bar
- [x] Filter bar above requirements table with dropdowns/multi-selects for each filterable field
- [x] Hierarchy Node filter shows mini tree picker with "Include descendants" checkbox
- [x] Filters apply and update the table (immediate or on "Apply" click)
- [x] Clear all filters button

### Frontend — Saved Filters
- [x] "Save Filter" button: prompts for name, saves current filter config
- [x] Saved filters displayed as quick-access tabs or dropdown above table
- [x] Click saved filter to restore that filter configuration
- [x] Delete saved filter

### Frontend — Table Enhancements
- [x] Column reordering via drag-and-drop on column headers
- [x] Column resizing via drag on column edges

### Stage 5 Verification
- [x] With 10+ requirements across 2+ disciplines, filter to Mechanical + Draft status — verify table updates
- [x] Save filter as "Mech Drafts" — clear all filters — click "Mech Drafts" — verify it restores
- [ ] Filter by hierarchy node = HeatRejection Module with Include Descendants — verify requirements on ACC, Feed Pumps, etc. appear
- [x] Verify column reorder and resize work and persist across page refresh

---

## Stage 6 — Requirement Attachments + Polish

### Backend — Database
- [x] Alembic migration: `requirement_attachments` table (id UUID, requirement_id FK, file_name text, file_path text, file_size integer, uploaded_by text, uploaded_at timestamp)

### Backend — API Endpoints
- [x] `POST /api/requirements/{id}/attachments` — upload file to MinIO, create attachment record
- [x] `GET /api/requirements/{id}/attachments` — list attachments for a requirement
- [x] `GET /api/attachments/{id}/download` — download attachment file

### Frontend — Attachments
- [x] Attachments section on requirement detail view
- [x] Upload widget (drag-and-drop or file picker)
- [x] Attachment list with file name, size, uploaded by, uploaded date
- [x] Download button per attachment

### Frontend — UI Polish
- [ ] Consistent loading states (spinners/skeletons) for all API calls
- [x] Error handling: user-visible error messages for failed API calls
- [x] Empty states: "No requirements yet — create one" on empty table, "No documents yet" on empty registry
- [ ] Breadcrumb navigation: Table View → Detail View → Tree View (and back)
- [ ] Responsive layout for standard laptop screens (no horizontal scroll in table at default column widths)
- [x] Archived hierarchy nodes grayed out (visible in admin context, hidden in normal nav)
- [x] Status colored badges in table: Draft=gray, Under Review=yellow, Approved=green, Superseded=orange, Withdrawn=red
- [x] Keyboard shortcut for creating a new requirement (Ctrl+N or similar)

### Stage 6 Verification
- [x] Attach a PDF to a requirement — download it — verify file is intact
- [ ] Navigate: table → detail → tree → parent detail — verify breadcrumbs track the path
- [ ] Test on 13" laptop screen — verify no overflow or horizontal scroll in table
- [x] Verify all empty states render correctly on a fresh database
- [ ] Verify loading spinners appear during API calls
- [x] Verify error messages appear when API calls fail (e.g., stop the API container and try to create a requirement)

---

## Post-Stage 6: Phase 1 MVP Complete

At this point, the application supports:
- Fully configurable system hierarchy (Geoblock default)
- Requirement CRUD with all mandatory/optional fields from PRD §4
- Requirement vs. Guideline classification (NASA TP-3642)
- Parent/child traceability links with bi-directional editing and cycle detection
- Navigable requirement derivation tree
- Source document registry with PDF upload, viewing, and manual extraction
- Filterable/sortable requirements table with saved filters
- File attachments on requirements
- Multi-select hierarchy nodes, sites, and units per requirement
- Owner assignment with display-name-based user identity
- Containerized with Docker Compose, ready for deployment to internal infrastructure

Proceed to Phase 2 stages below.

---
---

# Phase 2 — Core Workflows + AI Extraction
# Staged Implementation Checklist

Phase 2 builds on the completed Phase 1 MVP. The major addition is AI-assisted
requirement extraction from PDFs, which replaces the manual highlight-and-convert
workflow from Phase 1 Stage 4 with an LLM-powered pipeline. Phase 2 also adds
conflict tracking, orphan/gap analysis, full-text search, document revision
tracking, requirements document export, and email+password authentication.

Items demoted to Phase 4: CSV import/export, standard reports, saved filter sharing.

---

## Stage 7 — AI-Assisted Requirement Extraction + Block-Based Document Viewer

### Goal
Replace the manual text-highlight extraction workflow with an LLM-powered pipeline
that reads an uploaded PDF, decomposes it into structured text blocks (like a Notion
document), and proposes candidate requirements from those blocks. The user reviews,
edits, and approves each suggestion. This is the highest-value Phase 2 feature
because the traditional PDF scraping tools (pymupdf, pdfplumber) cannot reliably
parse the complex formatting in engineering specifications (nested clause numbers,
tables, multi-column layouts, checkbox forms).

### Backend — LLM Integration
- [x] Add Google Gemini SDK (`google-genai`) to backend dependencies
- [x] API key management: read `GEMINI_API_KEY` from environment variable (added to `.env` / `.env.example`)
- [x] New service module: `services/extraction.py` that handles the LLM extraction pipeline
- [x] **Document decomposition endpoint**: `POST /api/source-documents/{id}/decompose`
  - [x] Reads the PDF from MinIO
  - [x] Sends the PDF to Gemini with a structured prompt that instructs it to:
    - Decompose the document into a hierarchical structure of text blocks, preserving clause numbering (e.g., §5.3.1 is a child of §5.3 which is a child of §5)
    - For each block, return: clause number, heading (if any), full text content, nesting depth, and block type (heading, requirement clause, table row, informational, boilerplate)
    - Return results as a structured JSON array
  - [x] Stores the block structure in the database
  - [x] Returns the block tree to the frontend
- [x] **Requirement extraction endpoint**: `POST /api/source-documents/{id}/extract-requirements`
  - [x] Can operate on the full document or on user-selected blocks
  - [x] Sends selected blocks to Gemini with a prompt that instructs it to:
    - Identify all individual requirement statements in the provided blocks
    - For each requirement, return: the requirement statement text, the source clause number, a suggested classification (Requirement vs. Guideline per NASA TP-3642), a suggested discipline, and a suggested title (≤120 chars)
    - Decompose compound requirements into separate atomic statements
    - Return results as structured JSON
  - [x] Parses the LLM response and stores candidate requirements in a staging table
  - [x] Returns the list of candidates to the frontend

### Backend — Database
- [x] Alembic migration: `document_blocks` table (id UUID, source_document_id FK, parent_block_id nullable self-FK, clause_number text, heading text nullable, content text, block_type enum: heading/requirement_clause/table_row/informational/boilerplate, sort_order integer, depth integer, created_at)
- [x] Alembic migration: `extraction_candidates` table (id UUID, source_document_id FK, source_block_id FK nullable, title text, statement text, source_clause text, suggested_classification enum, suggested_discipline enum, status enum: Pending/Accepted/Rejected/Edited, accepted_requirement_id FK nullable, created_at)
- [x] When a candidate is accepted, create a real requirement record with: Source Type = "Derived from Document", Source Document linked, Source Clause populated, Owner = current user, Status = Draft, and all LLM-suggested field values as defaults (user can edit before confirming)

### Backend — API Endpoints
- [x] `POST /api/source-documents/{id}/decompose` — trigger LLM decomposition, return block tree
- [x] `GET /api/source-documents/{id}/blocks` — list blocks for a document as nested tree
- [x] `PUT /api/document-blocks/{id}` — edit a block's content (user can correct OCR/parsing errors)
- [x] `POST /api/source-documents/{id}/extract-requirements` — trigger LLM extraction from selected blocks (or all blocks), return candidates
- [x] `GET /api/source-documents/{id}/candidates` — list extraction candidates for a document
- [x] `PUT /api/extraction-candidates/{id}` — update a candidate (edit fields, change status to Accepted/Rejected)
- [x] `POST /api/extraction-candidates/{id}/accept` — accept candidate, create real requirement, link back

### Frontend — Block-Based Document Viewer
- [x] On the Source Document Detail View, replace the raw extracted text panel with a **block-based viewer**
- [x] After decomposition, the document appears as a flat list of text blocks with depth-based indentation
- [x] Each block shows: clause number, content text, block type badge (color-coded)
- [~] Blocks are collapsible by their parent/child hierarchy — deferred, flat list with depth indentation used instead
- [x] Users can select individual blocks via checkboxes
- [x] Users can edit block content inline (to correct parsing errors)
- [x] "Decompose Document" button triggers the LLM decomposition (blocks cached after; button becomes "Re-decompose")
- [x] "Extract Requirements from Selected" button sends selected blocks to the extraction endpoint
- [x] "Extract All Requirements" button sends all non-boilerplate blocks

### Frontend — Extraction Review Interface
- [x] **Candidate Review Panel**: after extraction completes, display candidates alongside the block viewer. Each candidate shows:
  - [x] Suggested title, statement, source clause, classification, discipline
  - [x] Link back to the source block (clicking highlights the block in the viewer)
  - [x] "Accept" button (creates the requirement as-is with current user as owner, Status = Draft)
  - [x] "Edit & Accept" button (opens an editable form where the user can modify any field before accepting)
  - [x] "Reject" button (marks the candidate as rejected, does not create a requirement)
  - [~] "Accept All Remaining" button — intentionally omitted; reviewers must own each accepted requirement individually
- [x] Accepted candidates show a green checkmark and link to the created requirement
- [x] Rejected candidates are dimmed with a red indicator
- [x] Count display: "X of Y candidates accepted, Z rejected, W pending"
- [x] Blocks that have been extracted into accepted requirements show a visual indicator (e.g., green left border)

### Prompt Engineering
- [x] **Decomposition prompt** instructs the LLM to:
  - [x] Preserve the document's clause numbering hierarchy faithfully
  - [x] Identify block types: headings, requirement clauses (contain "shall"/"should"/"may"), table rows, informational text, boilerplate (TOC, revision history, signature blocks, distribution lists)
  - [x] Handle tables by decomposing each meaningful row into its own block
  - [x] Return a flat JSON array with parent references to represent nesting
- [x] **Extraction prompt** instructs the LLM to:
  - [x] Treat each "shall" statement as a candidate Requirement
  - [x] Treat "should" and "may" statements as candidate Guidelines
  - [x] Decompose compound requirements (a single clause containing multiple obligations) into separate atomic statements
  - [x] Ignore boilerplate blocks
  - [x] Reference source clause numbers from the block structure
  - [x] Return results as a JSON array with a consistent schema
- [x] Test both prompts against at least two different document types: one Kiewit equipment spec (e.g., MSPEC-KIE format) and one Fervo internal BOD (e.g., CAP-02-EE-BOD format)

### Stage 7 Verification
- [x] Upload a real engineering specification PDF (or representative test document)
- [x] Click "Decompose Document" — verify blocks appear in the block viewer within ~60 seconds
- [x] Verify block hierarchy reflects the document's clause structure (e.g., §5.3.1 nested under §5.3)
- [x] Verify block types are correctly identified (requirement clauses, tables, boilerplate)
- [x] Edit a block's content — verify the edit persists
- [x] Select a range of blocks, click "Extract Requirements from Selected" — verify candidates appear
- [x] Verify each candidate has a title, statement, source clause, classification, and discipline
- [x] Verify clicking a candidate's source clause highlights the corresponding block in the viewer
- [x] Accept one candidate — verify a real requirement is created with Source Type = Derived from Document, source document linked, owner = current user, status = Draft
- [x] Edit & Accept another candidate — modify the title — verify the created requirement has the edited title
- [x] Reject a candidate — verify it is marked rejected and no requirement is created
- [x] Verify the source block of an accepted requirement shows a green indicator
- [x] Verify accepted requirements appear in the requirements table view and document's "derived requirements" list
- [x] Re-run extraction on the same document — verify previously extracted candidates are shown alongside new ones (no duplicates created)

---

## Stage 8 — Source Document Dependency Graph

### Goal
Build an interactive, force-directed network visualization showing all source
documents as nodes and their reference relationships as edges. This is the
same type of visualization as the specification dependency diagram already built
in this project — but now it's live, driven by real data in the document registry
rather than hard-coded arrays. It answers: "Which documents depend on which?"
and "If API 661 is revised, which of our specs are affected?"

### Backend — Database
- [x] Alembic migration: `document_references` table (id UUID, source_document_id FK, referenced_document_id FK, reference_context text nullable, created_at). Unique constraint on the source/referenced pair.
- [~] During LLM decomposition (Stage 7), extend the extraction prompt to also identify cross-references — deferred to a later pass; manual references are available now.
- [x] Users can also manually add/remove document references via the UI.

### Backend — API Endpoints
- [x] `GET /api/document-references/graph` — returns all documents as nodes (with id, title, document_type, discipline, reference count) and all references as edges (source_id, target_id), formatted for the frontend graph renderer
- [x] `POST /api/document-references` — manually add a reference between two documents
- [x] `DELETE /api/document-references/{id}` — remove a reference
- [x] `GET /api/source-documents/{id}/references` — outgoing references (documents this one references)
- [x] `GET /api/source-documents/{id}/referenced-by` — incoming references (documents that reference this one)

### Frontend — Document Dependency Graph View
- [x] New page/tab: "Document Network" — interactive force-directed graph
- [x] Nodes represent source documents, sized by total connection count (in + out references)
- [x] Nodes colored by document type (Code/Standard, Internal Specification, Basis of Design, Contract/PPA, etc.)
- [x] Edges represent reference relationships with directionality (arrows showing which doc references which)
- [x] Hover a node: highlight all connected nodes and edges, dim everything else. Show a tooltip panel with document title, type, issuing org, revision, and connection counts (references / referenced by)
- [x] Click a node: select it, show detail panel with outgoing and incoming reference lists. Each listed document is clickable. "Open Document" button navigates to the document detail view.
- [x] Pan and zoom controls (mouse wheel zoom, click-drag pan)
- [x] Legend showing document type color coding
- [x] On the Source Document Detail View, add a "References" section showing outgoing and incoming document references, with an "Add Reference" button (searchable dropdown of other documents in the registry) and a "View in Network" button that opens the graph centered on this document

### Frontend — Graph Interaction with Revision Tracking
- [~] When a document has been superseded (from Stage 11 revision tracking), its node shows a visual indicator — deferred; depends on Stage 11 revision tracking data.
- [~] "Impact Analysis" mode — deferred to a later pass.

### Stage 8 Verification
- [ ] Register 5+ source documents with cross-references between them (e.g., ACC spec references API 661, ASME Sec VIII, ASME B31.3; Electrical BOD references NFPA 70, IEEE 841)
- [ ] Open Document Network view — verify all documents appear as nodes with edges between them
- [ ] Verify node sizes reflect connection counts
- [ ] Verify node colors match document types
- [ ] Hover a node — verify connected nodes highlight and tooltip shows metadata
- [ ] Click a node — verify detail panel shows outgoing/incoming references
- [ ] Click "Open Document" — verify navigation to document detail view
- [ ] On a document detail view, click "Add Reference" — add a reference to another document — verify it appears in the graph
- [ ] On a document detail view, click "View in Network" — verify graph opens centered on that document

---

## Stage 9 — Conflict Record Tracking

### Goal
Allow users to flag pairs of requirements as conflicting, describe the nature of
the conflict, and track resolution. Conflicts appear as a field on each involved
requirement.

### Backend — Database
- [ ] Alembic migration: `conflict_records` table (id UUID, description text, status enum: Open/Under Discussion/Resolved/Deferred, resolution_notes text nullable, created_by text, created_at, updated_at)
- [ ] Alembic migration: `conflict_record_requirements` junction table (conflict_record_id FK, requirement_id FK) — supports linking 2+ requirements to a single conflict
- [ ] Update requirement detail endpoint to include associated conflict records

### Backend — API Endpoints
- [ ] `POST /api/conflict-records` — create a conflict record (accepts list of requirement IDs, description)
- [ ] `GET /api/conflict-records` — list all conflict records with filtering by status
- [ ] `GET /api/conflict-records/{id}` — single conflict record with linked requirements
- [ ] `PUT /api/conflict-records/{id}` — update status, description, resolution notes
- [ ] `DELETE /api/conflict-records/{id}` — soft delete

### Frontend — Conflict Record UI
- [ ] On the Requirement Detail View, new "Conflict Records" section showing all conflicts involving this requirement
- [ ] Each conflict shows: description, status badge, linked requirements (clickable), resolution notes
- [ ] "Flag Conflict" button on the detail view: opens a form to select one or more other requirements, describe the conflict, and create the record
- [ ] Conflict status is editable inline (dropdown to change Open → Under Discussion → Resolved → Deferred)
- [ ] Resolution notes field becomes editable when status changes to Resolved or Deferred
- [ ] Requirements table view: add a "Conflicts" column showing count of open conflicts (filterable: "has open conflicts" checkbox)

### Stage 9 Verification
- [ ] Create two contradictory requirements (e.g., one specifying 120 psig design pressure, another specifying 150 psig for the same equipment)
- [ ] Flag them as conflicting with a description of the conflict
- [ ] Verify the conflict record appears on both requirements' detail views
- [ ] Change conflict status to Resolved, add resolution notes
- [ ] Verify the conflict count in the table view updates
- [ ] Filter the table to show only requirements with open conflicts

---

## Stage 10 — Orphan Report + Gap Analysis + Full-Text Search

### Goal
Add analytical views that help engineers identify missing traceability and
requirements gaps, plus global search.

### Backend — API Endpoints
- [ ] `GET /api/reports/orphans` — returns requirements whose only parent is Self-Derived AND are assigned to non-root hierarchy nodes (potential missing traceability)
- [ ] `GET /api/reports/gaps?requirement_id={id}` — for a given parent requirement, returns a list of hierarchy nodes that have child requirements derived from it vs. hierarchy nodes that don't (identifies where flow-down is missing)
- [ ] `GET /api/search?q={query}` — full-text search across requirement titles, statements, rationale, tags, source document titles, owner names. Uses PostgreSQL `tsvector` / `tsquery` for performance.

### Backend — Database
- [ ] Alembic migration: add GIN index on a generated `tsvector` column covering requirement title, statement, rationale, tags, and owner fields
- [ ] Alembic migration: add GIN index on source_documents covering title and document_id

### Frontend — Orphan Report
- [ ] New page/tab: "Orphan Report" — table of requirements flagged as orphans
- [ ] Each row shows Requirement ID, Title, Owner, Hierarchy Nodes, Status
- [ ] Clicking a row opens the requirement detail view where the user can assign parent requirements

### Frontend — Gap Analysis
- [ ] Accessible from the Requirement Detail View: "Analyze Flow-Down Gaps" button on any requirement
- [ ] Displays a list of hierarchy nodes, each showing whether a child requirement derived from this parent exists at that node
- [ ] Nodes with coverage shown in green; nodes without coverage shown in red/amber with a "Create Child Requirement" shortcut

### Frontend — Global Search
- [ ] Search bar in the top navigation, always visible
- [ ] Results grouped by type: Requirements, Source Documents
- [ ] Each result shows title/ID, a snippet of matching text, and is clickable to open the detail view
- [ ] Search results appear in a dropdown as the user types (debounced, ≥3 characters)

### Stage 10 Verification
- [ ] Create a requirement assigned to a low-level hierarchy node with only Self-Derived as parent — verify it appears in the orphan report
- [ ] Assign a real parent to it — verify it disappears from the orphan report
- [ ] Select a top-level requirement and run gap analysis — verify hierarchy nodes with/without derived children are correctly identified
- [ ] Click "Create Child Requirement" from a gap — verify new requirement form opens pre-linked
- [ ] Search for a word that appears in a requirement statement — verify the requirement appears in results
- [ ] Search for a source document title — verify it appears in results
- [ ] Search for an owner's name — verify their requirements appear in results

---

## Stage 11 — Document Revision Tracking + Requirements Export

### Goal
Flag stale requirements when source documents are revised, and generate formatted
requirements documents for inclusion in specification packages.

### Backend — Document Revision Tracking
- [ ] Add `superseded_by_id` (nullable self-FK) column to `source_documents` table
- [ ] When a user registers a new revision of an existing document, the system links old → new via `superseded_by_id`
- [ ] New endpoint: `POST /api/source-documents/{id}/new-revision` — creates new document record, links it as superseding the old one, flags all requirements derived from the old revision
- [ ] Add `stale` (boolean, default false) column to `requirements` table
- [ ] When a document is superseded, bulk-update all requirements with `source_document_id` = old doc to `stale = true`
- [ ] Update requirement list/detail endpoints to include the stale flag

### Frontend — Revision Tracking
- [ ] On Source Document Detail View, "Upload New Revision" button
- [ ] Confirmation dialog: "This will flag X requirements derived from the current revision as stale. Continue?"
- [ ] Stale requirements show a visual indicator (amber warning icon) in the table view and detail view
- [ ] Stale filter added to the table filter bar

### Backend — Requirements Document Export
- [ ] New endpoint: `GET /api/export/requirements-document` — accepts filter parameters (hierarchy node, discipline, status, etc.) and returns a formatted PDF or Word document
- [ ] Document organized by hierarchy node (tree structure as headings/subheadings), with requirements listed under each node
- [ ] Each requirement shows: ID, Title, Statement, Classification, Source Document, Source Clause, Owner, Status
- [ ] Use a Python library like `python-docx` (Word) or `reportlab` / `weasyprint` (PDF)

### Frontend — Export
- [ ] "Export Document" button on the requirements table view (uses current filters to scope the export)
- [ ] Format selection: PDF or Word
- [ ] Download triggers immediately after generation

### Stage 11 Verification
- [ ] Register a source document at Rev A with several derived requirements
- [ ] Upload Rev B as a new revision — verify all Rev A requirements are flagged as stale
- [ ] Verify stale indicator appears in table and detail views
- [ ] Verify stale filter works in the table
- [ ] Export a requirements document filtered to a specific hierarchy node — verify the PDF/Word file is well-formatted with hierarchy structure as headings
- [ ] Verify requirements appear under their correct hierarchy nodes in the export

---

## Stage 12 — Email + Password Authentication

### Goal
Replace the display-name-only user identity with proper email + password
authentication so the app can be shared beyond a trusted local network.

### Backend — Database
- [ ] Alembic migration: `users` table (id UUID, email text unique, display_name text, password_hash text, created_at, updated_at)
- [ ] Migrate existing display-name-based owner references to be compatible with user accounts (owner field becomes a FK to users table, with a migration that creates user records for each unique display name currently in the system)

### Backend — Authentication
- [ ] Password hashing with bcrypt
- [ ] `POST /api/auth/register` — create new user account (email, display name, password)
- [ ] `POST /api/auth/login` — validate credentials, return JWT token
- [ ] `POST /api/auth/logout` — invalidate token (if using token blacklist) or no-op (if relying on expiry)
- [ ] JWT middleware: all API endpoints (except register/login) require a valid JWT in the Authorization header
- [ ] Token includes user ID and display name; backend extracts current user from token

### Frontend — Authentication
- [ ] Login page: email + password form
- [ ] Registration page: email + display name + password form
- [ ] JWT stored in memory (not localStorage for security) with refresh mechanism
- [ ] Redirect to login page when JWT is missing or expired
- [ ] Current user display name shown in top nav (replacing the manual text input from Phase 1)
- [ ] Owner fields throughout the app now reference real user accounts (searchable dropdown of registered users)

### Stage 12 Verification
- [ ] Register a new user account — verify success
- [ ] Log in with the new account — verify redirect to main app
- [ ] Verify all API calls work with the JWT token
- [ ] Open a private/incognito window — verify redirect to login page
- [ ] Create a requirement — verify Owner is automatically set to the logged-in user
- [ ] Verify existing requirements (created with display names in Phase 1) still display correctly

---

## Post-Stage 12: Phase 2 Complete

At this point, the application additionally supports:
- AI-assisted requirement extraction from uploaded PDFs via Anthropic API
- Block-based document viewer with hierarchical clause structure (Notion-style)
- Selective extraction from individual blocks or block ranges
- Candidate review and acceptance workflow for extracted requirements
- Source document dependency graph (interactive force-directed network)
- Cross-reference detection during LLM extraction
- Impact analysis ("if this code is revised, what specs are affected?")
- Conflict record tracking between requirements
- Orphan report identifying requirements with missing traceability
- Gap analysis showing where requirement flow-down is incomplete
- Global full-text search across requirements and documents
- Source document revision tracking with stale requirement flagging
- Formatted requirements document export (PDF/Word)
- Email + password authentication with JWT tokens

Proceed to Phase 3 (PRD §13) for AI-assisted conflict detection and
AI-assisted derivation suggestions.

Proceed to Phase 4 (PRD §13) for roles/permissions, owner dashboard,
approval workflows, SSO, multi-project, API integrations, notifications,
system-managed audit trail, CSV import/export, standard reports, and
saved filter sharing.
