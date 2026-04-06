# CLAUDE.md — Project Context for Claude Code

This file is read automatically by Claude Code at the start of every session.
It captures persistent context about the user, the project, and working conventions.

---

## About the User

The primary user is a **mechanical systems engineer** who is experienced in power plant
engineering and systems engineering practice, but is **new to web development**.

When working on this project:
- **Do explain** web development jargon, framework concepts, and tooling as you go.
  A brief inline explanation is enough — the goal is to build the user's mental model,
  not to write a tutorial.
- **Do not over-explain** engineering or systems engineering concepts — the user knows
  these domains deeply and the domain model in this app (hierarchy trees, traceability
  links, requirement lifecycle) will be intuitive to them.
- Use engineering analogies when introducing web concepts where helpful
  (e.g., a database migration is like a design revision — it records exactly what
  changed and when, and can be rolled back).

---

## About the Project

A lightweight, web-based requirements management application purpose-built for
geothermal power plant engineering programs. Replaces spreadsheets and PDF markup
with structured traceability.

**Tech stack:**
- Frontend: React + TypeScript + Vite (port 3000)
- Backend: FastAPI (Python) (port 8000)
- Database: PostgreSQL 16
- File storage: MinIO (S3-compatible, console port 9001)
- Containerized via Docker Compose

**Key domain concepts (from PRD v0.3):**
- Two parallel tree structures: the System Hierarchy Tree (what the plant is made of)
  and the Requirement Derivation Tree (where each requirement came from and what it
  flows down to)
- Requirements vs. Guidelines distinction per NASA TP-3642
- Every requirement has exactly one Owner
- Requirement IDs: [DISCIPLINE_PREFIX]-[ZERO_PADDED_SEQ] (e.g., MECH-001, ELEC-117)
- "Self-Derived" is a system placeholder requirement that serves as the parent for all
  top-level requirements with no upstream source
- Sites: Cape Phase II, Red
- Units: ORC Unit 1–8, All Units

**Phased delivery:**
- Phase 1 (MVP, in progress): Hierarchy CRUD, Requirement CRUD, traceability,
  source docs, PDF upload, filtering, attachments. No authentication.
- Phase 2: Conflict records, CSV import/export, full-text search, email+password auth
- Phase 3: AI-assisted extraction and conflict detection
- Phase 4: Enterprise (RBAC, SSO, multi-project, audit trail)

**Progress is tracked in:** `implementation_plan.md`

---

## Working Conventions

- Explanatory responses with `> **Insight:**` blockquotes surfacing key decisions
- Explain web/framework-specific terms inline as they come up
- Do not auto-grant permissions for destructive commands (rm, docker rm, etc.) —
  see `.claude/settings.local.json`
- Soft deletes only — no requirement or hierarchy node is ever physically removed
- All schema changes go through Alembic migrations, never `Base.metadata.create_all`
