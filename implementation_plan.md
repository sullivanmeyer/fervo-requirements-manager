# Phase 1 MVP — Staged Implementation Checklist
# Requirements Management Application
# Last updated: April 2026

This file tracks Claude Code's progress through the Phase 1 MVP build.
Check each box as the item is implemented and verified.
Refer to the PRD (v0.3) for full field definitions and business logic.

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
- [ ] Add a child from the detail view — verify new requirement is pre-linked

---

## Stage 4 — Source Document Registry + PDF Upload

### Backend — Database
- [ ] Alembic migration: `source_documents` table (id UUID, document_id text, title, document_type enum, revision text, issuing_organization text, disciplines text array, file_path text nullable, extracted_text text nullable, created_at, updated_at)
- [ ] Alembic migration: add `source_document_id` (nullable FK) and `source_clause` (text nullable) columns to `requirements` table

### Backend — File Storage
- [ ] MinIO bucket creation on startup (e.g., bucket named "documents")
- [ ] `POST /api/source-documents/{id}/upload` — accepts PDF, stores in MinIO, returns S3 key
- [ ] `GET /api/source-documents/{id}/download` — returns the PDF file
- [ ] PDF text extraction using pymupdf or pdfplumber — extracted text stored in source_documents.extracted_text

### Backend — API Endpoints
- [ ] `GET /api/source-documents` — list all source documents
- [ ] `GET /api/source-documents/{id}` — full detail including extracted text and list of linked requirements
- [ ] `POST /api/source-documents` — create document record
- [ ] `PUT /api/source-documents/{id}` — update document metadata

### Frontend — Source Document Registry
- [ ] New page: table of all source documents (Document ID, Title, Type, Revision, Issuing Org)
- [ ] "Create" button to add new document record
- [ ] File upload widget to attach a PDF to a document record

### Frontend — Document Detail View
- [ ] Shows document metadata
- [ ] Embedded PDF viewer (iframe or react-pdf)
- [ ] Extracted text display panel
- [ ] List of all requirements derived from this document (filtered from requirements table)
- [ ] "Create Requirement from Selection": user highlights text in extracted text panel, clicks button, new requirement form opens with Statement pre-populated, Source Type = Derived from Document, Source Document pre-linked

### Frontend — Requirement Detail/Edit View Updates
- [ ] Source Document field: searchable dropdown from document registry
- [ ] Source Clause field: free text
- [ ] Source Document required when Source Type = "Derived from Document"

### Stage 4 Verification
- [ ] Register source document: "API 661, 7th Edition" — Type=Code/Standard, Issuing Org=API
- [ ] Upload a test PDF — verify it renders in embedded viewer
- [ ] Verify extracted text is visible in text panel
- [ ] Highlight a passage, click "Create Requirement from Selection"
- [ ] Verify new requirement form has Statement pre-populated, Source Type and Source Document pre-linked
- [ ] Save requirement — verify it appears in the document's "derived requirements" list
- [ ] Verify Source Document and Source Clause fields work on the requirement detail view

---

## Stage 5 — Table Filtering + Saved Filters

### Backend — Database
- [ ] Alembic migration: `saved_filters` table (id UUID, name text, filter_config JSONB, user_name text, created_at)

### Backend — API Endpoints
- [ ] Extend `GET /api/requirements` to accept filter parameters:
  - [ ] status (multi-select)
  - [ ] classification (single select)
  - [ ] discipline (multi-select)
  - [ ] owner (text search / partial match)
  - [ ] hierarchy_node_id with include_descendants boolean
  - [ ] site (multi-select)
  - [ ] units (multi-select)
  - [ ] source_type (single select)
  - [ ] source_document_id (single select)
  - [ ] tags (multi-select / partial match)
  - [ ] created_date range (from/to)
  - [ ] modified_date range (from/to)
- [ ] `POST /api/saved-filters` — create saved filter
- [ ] `GET /api/saved-filters` — list saved filters (optionally filtered by user_name)
- [ ] `DELETE /api/saved-filters/{id}` — delete saved filter

### Frontend — Filter Bar
- [ ] Filter bar above requirements table with dropdowns/multi-selects for each filterable field
- [ ] Hierarchy Node filter shows mini tree picker with "Include descendants" checkbox
- [ ] Filters apply and update the table (immediate or on "Apply" click)
- [ ] Clear all filters button

### Frontend — Saved Filters
- [ ] "Save Filter" button: prompts for name, saves current filter config
- [ ] Saved filters displayed as quick-access tabs or dropdown above table
- [ ] Click saved filter to restore that filter configuration
- [ ] Delete saved filter

### Frontend — Table Enhancements
- [ ] Column reordering via drag-and-drop on column headers
- [ ] Column resizing via drag on column edges

### Stage 5 Verification
- [ ] With 10+ requirements across 2+ disciplines, filter to Mechanical + Draft status — verify table updates
- [ ] Save filter as "Mech Drafts" — clear all filters — click "Mech Drafts" — verify it restores
- [ ] Filter by hierarchy node = HeatRejection Module with Include Descendants — verify requirements on ACC, Feed Pumps, etc. appear
- [ ] Verify column reorder and resize work and persist across page refresh

---

## Stage 6 — Requirement Attachments + Polish

### Backend — Database
- [ ] Alembic migration: `requirement_attachments` table (id UUID, requirement_id FK, file_name text, file_path text, file_size integer, uploaded_by text, uploaded_at timestamp)

### Backend — API Endpoints
- [ ] `POST /api/requirements/{id}/attachments` — upload file to MinIO, create attachment record
- [ ] `GET /api/requirements/{id}/attachments` — list attachments for a requirement
- [ ] `GET /api/attachments/{id}/download` — download attachment file

### Frontend — Attachments
- [ ] Attachments section on requirement detail view
- [ ] Upload widget (drag-and-drop or file picker)
- [ ] Attachment list with file name, size, uploaded by, uploaded date
- [ ] Download button per attachment

### Frontend — UI Polish
- [ ] Consistent loading states (spinners/skeletons) for all API calls
- [ ] Error handling: user-visible error messages for failed API calls
- [ ] Empty states: "No requirements yet — create one" on empty table, "No documents yet" on empty registry
- [ ] Breadcrumb navigation: Table View → Detail View → Tree View (and back)
- [ ] Responsive layout for standard laptop screens (no horizontal scroll in table at default column widths)
- [ ] Archived hierarchy nodes grayed out (visible in admin context, hidden in normal nav)
- [ ] Status colored badges in table: Draft=gray, Under Review=yellow, Approved=green, Superseded=orange, Withdrawn=red
- [ ] Keyboard shortcut for creating a new requirement (Ctrl+N or similar)

### Stage 6 Verification
- [ ] Attach a PDF to a requirement — download it — verify file is intact
- [ ] Navigate: table → detail → tree → parent detail — verify breadcrumbs track the path
- [ ] Test on 13" laptop screen — verify no overflow or horizontal scroll in table
- [ ] Verify all empty states render correctly on a fresh database
- [ ] Verify loading spinners appear during API calls
- [ ] Verify error messages appear when API calls fail (e.g., stop the API container and try to create a requirement)

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

Proceed to Phase 2 (PRD §13) for conflict records, CSV import/export, full-text search,
email+password auth, reports, and document revision tracking.
