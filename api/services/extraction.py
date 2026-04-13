"""
LLM-powered document extraction service — Google Gemini backend.

Two-step pipeline:
  1. decompose_document  — sends the PDF to Gemini and returns a flat list of
                           structured text blocks preserving clause hierarchy.
  2. extract_requirements — sends a list of block texts to Gemini and returns
                            candidate requirement statements with metadata.

JSON output is requested via explicit prompting; a regex fallback strips
markdown code fences if the model adds them.
"""

from __future__ import annotations

import json
import os
import re
import tempfile
import time
from typing import Any

from google import genai
from google.genai import types

# ---------------------------------------------------------------------------
# Model config
# ---------------------------------------------------------------------------

MODEL = "gemini-2.5-flash"

# Retry config for transient 503 errors
_MAX_RETRIES = 3
_RETRY_DELAY_S = 5

# ---------------------------------------------------------------------------
# Prompt templates
# ---------------------------------------------------------------------------

DECOMPOSE_SYSTEM = """\
You are an expert at analyzing engineering specification documents.
Your output must be valid JSON — no prose before or after the JSON array.
"""

DECOMPOSE_USER = """\
Decompose this engineering specification document into a flat list of structured text blocks.

Rules:
- Preserve the document's clause/section numbering hierarchy faithfully.
- For each block include:
    clause_number   : string like "5.3.1" or "Table 4", or null if none
    heading         : the heading/title text if this block IS a heading, else null
    content         : the full verbatim text of this block (for table_block, include
                      the Markdown table as-is from the [TABLE BLOCK] marker)
    block_type      : one of:
                        "heading"            – section title, no substantive content
                        "requirement_clause" – contains SHALL / SHOULD / MAY obligations
                        "table_block"        – a complete table treated as one unit
                        "informational"      – explanatory or descriptive text
                        "boilerplate"        – TOC, revision history, signatures,
                                               distribution lists, legal notices
    table_data      : ONLY for table_block — a JSON object:
                        {
                          "caption": "Table title or null",
                          "headers": ["Col1", "Col2", ...],
                          "rows": [["Cell", "Cell"], ...],
                          "context_note": "brief note on what this table specifies"
                        }
                      For all other block types, set table_data to null.
    parent_clause_number : clause_number of the immediate parent block, or null
    depth           : nesting depth (0 = top-level section, 1 = sub-section, etc.)
- Order blocks in document reading order.
- Tables are pre-identified with [TABLE BLOCK] / [END TABLE BLOCK] markers.
  Output each marked table as a single table_block — do NOT break it into rows.
- If a table contains requirement language (SHALL / SHOULD / MAY), still output
  it as a single table_block and populate table_data.
- Ignore page headers / footers that repeat on every page.

Return ONLY a JSON array of objects matching the schema above.
Examples:

Prose requirement:
{
  "clause_number": "5.3.1",
  "heading": null,
  "content": "The pressure vessel shall be designed for a minimum design pressure of 150 psig.",
  "block_type": "requirement_clause",
  "table_data": null,
  "parent_clause_number": "5.3",
  "depth": 2
}

Table block:
{
  "clause_number": "Table 3",
  "heading": "Design Parameters",
  "content": "| Parameter | Value | Unit |\\n|---|---|---|\\n| Design Pressure | 150 | psig |",
  "block_type": "table_block",
  "table_data": {
    "caption": "Table 3 — Design Parameters",
    "headers": ["Parameter", "Value", "Unit"],
    "rows": [["Design Pressure", "150", "psig"]],
    "context_note": "Specifies minimum design parameters for the pressure vessel"
  },
  "parent_clause_number": "5.3",
  "depth": 2
}
"""

DETECT_REFS_SYSTEM = """\
You are an expert at identifying normative document references in engineering specifications.
Your output must be valid JSON — no prose before or after the JSON array.
"""

DETECT_REFS_USER_TEMPLATE = """\
Scan the following engineering document text and identify every reference to an external
document — codes, standards, specifications, regulations, industry guidelines, or other
normative references.

For each reference return an object with:
  "document_number"  : the base identifier stripped of any revision, edition, or year.
                       Examples: "API 661", "ASME B31.3", "NFPA 70", "IEEE 841", "ISO 9001"
  "full_reference"   : the complete reference as it appears in the text, e.g. "API 661, 7th Edition"
  "context"          : one short phrase showing where it is cited, e.g. "per API 661 §5.1"

Rules:
- Only external normative references — NOT "this specification", "the project", "the engineer"
- Strip edition numbers, revision numbers, years from document_number
  (e.g. "ASME B31.3-2022" → "ASME B31.3"; "API 661, 7th Ed." → "API 661")
- If the same base document appears multiple times, include it once using the most complete form
- Return ONLY a JSON array.  If no external references are found, return [].

=== DOCUMENT TEXT ===
{text}
"""

EXTRACT_SYSTEM = """\
You are an expert at extracting engineering requirements from specification text.
Your output must be valid JSON — no prose before or after the JSON array.
"""

EXTRACT_USER_TEMPLATE = """\
Extract all engineering requirement statements from the following document blocks.

Rules:
- Each "shall" statement is a Requirement (classification = "Requirement").
- Each "should" or "may" statement is a Guideline (classification = "Guideline").
- Decompose compound clauses (one clause with multiple "shall"s) into separate
  atomic statements — one per output object.
- Ignore boilerplate blocks entirely.
- For each extracted requirement include:
    title                             : concise human-readable summary (≤120 characters)
    statement                         : the full, verbatim or lightly cleaned requirement text,
                                        beginning with the subject ("The [subject] shall …")
    source_clause                     : clause_number of the source block, or null
    suggested_classification          : "Requirement" or "Guideline"
    suggested_classification_subtype  : one of the following, based on classification:
      If Requirement → "Performance Requirement" (plant-peculiar what's: reliability,
                          capacity, operating envelopes, throughput)
                      | "Design Requirement" (standards, margins, redundancy, material
                          specs, safety factors, interface constraints from codes)
                      | "Derived Requirement" (requirements that evolve during design
                          to meet performance requirements: e.g. load relief controls,
                          interface control specs)
      If Guideline  → "Lesson Learned" (experience-based guidance, historical knowledge)
                    | "Procedure" (steps, methods, fabrication/inspection sequences)
                    | "Code" (reference to industry codes, standards, handbooks,
                        engineering equations, computer programs)
    suggested_discipline              : one of Mechanical / Electrical / I&C /
                                        Civil/Structural / Process / Fire Protection / General /
                                        Build / Operations
                                        (Build covers fabrication, construction, installation,
                                        assembly, quality hold points; Operations covers startup,
                                        shutdown, maintenance, inspection intervals, operating
                                        procedures)
    source_block_index                : 0-based index of the block in the list below

Return ONLY a JSON array.  If no requirements are found, return [].

=== BLOCKS ===
{blocks_json}
"""

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _get_client() -> genai.Client:
    api_key = os.environ.get("GEMINI_API_KEY", "")
    if not api_key:
        raise RuntimeError(
            "GEMINI_API_KEY environment variable is not set. "
            "Add it to your .env file and rebuild the API container."
        )
    return genai.Client(api_key=api_key)


def _generate_with_retry(client: genai.Client, **kwargs) -> Any:
    """Call generate_content with simple retry logic for transient 503s."""
    last_exc = None
    for attempt in range(_MAX_RETRIES):
        try:
            return client.models.generate_content(**kwargs)
        except Exception as e:
            if "503" in str(e) or "UNAVAILABLE" in str(e):
                last_exc = e
                if attempt < _MAX_RETRIES - 1:
                    time.sleep(_RETRY_DELAY_S)
            else:
                raise
    raise last_exc


def _parse_json_response(text: str) -> Any:
    """Extract a JSON array from the model's response, handling markdown fences."""
    # Strip markdown code fences (```json ... ``` or ``` ... ```)
    fenced = re.search(r"```(?:json)?\s*([\s\S]*?)\s*```", text)
    raw = fenced.group(1) if fenced else text.strip()

    # Find the outermost JSON array
    start = raw.find("[")
    end = raw.rfind("]")
    if start == -1 or end == -1:
        raise ValueError(f"No JSON array found in LLM response. Response was:\n{text[:500]}")
    return json.loads(raw[start : end + 1])


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def decompose_document(pdf_bytes: bytes) -> list[dict]:
    """
    Decompose a PDF into structured block dicts.

    Two-path approach:
    1. pdfplumber pre-processing (preferred): extracts text + serializes tables as
       Markdown with [TABLE BLOCK] markers, then sends as text to Gemini.
       Gemini outputs table_block entries with full table_data instead of row fragments.
    2. File API fallback: for scanned / image-only PDFs where pdfplumber extracts
       no text, upload the raw PDF to Gemini's File API (vision-capable).

    Each returned dict has:
      clause_number, heading, content, block_type, table_data,
      parent_clause_number, depth, sort_order
    """
    if not pdf_bytes:
        raise ValueError(
            "PDF bytes are empty — ensure the file was uploaded to storage "
            "correctly before decomposing."
        )

    client = _get_client()

    # ------------------------------------------------------------------
    # Path 1: pdfplumber text extraction (handles tables structurally)
    # ------------------------------------------------------------------
    from services.table_extraction import extract_content_with_tables

    extracted_text = extract_content_with_tables(pdf_bytes)

    if extracted_text:
        print(
            f"[decompose] pdfplumber extracted {len(extracted_text)} chars — "
            "using text-based path"
        )
        prompt = f"=== DOCUMENT CONTENT ===\n{extracted_text}\n\n{DECOMPOSE_USER}"
        response = _generate_with_retry(
            client,
            model=MODEL,
            contents=[
                types.Content(
                    role="user",
                    parts=[types.Part(text=prompt)],
                )
            ],
            config=types.GenerateContentConfig(
                system_instruction=DECOMPOSE_SYSTEM,
                response_mime_type="application/json",
            ),
        )
    else:
        # ------------------------------------------------------------------
        # Path 2: File API fallback for image-based / scanned PDFs
        # ------------------------------------------------------------------
        print("[decompose] pdfplumber returned no text — falling back to File API")
        with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as tmp:
            tmp.write(pdf_bytes)
            tmp_path = tmp.name

        try:
            uploaded = client.files.upload(
                file=tmp_path,
                config={"mime_type": "application/pdf"},
            )
        finally:
            os.unlink(tmp_path)

        try:
            response = _generate_with_retry(
                client,
                model=MODEL,
                contents=[
                    types.Content(
                        role="user",
                        parts=[
                            types.Part.from_uri(
                                file_uri=uploaded.uri,
                                mime_type="application/pdf",
                            ),
                            types.Part(text=DECOMPOSE_USER),
                        ],
                    )
                ],
                config=types.GenerateContentConfig(
                    system_instruction=DECOMPOSE_SYSTEM,
                    response_mime_type="application/json",
                ),
            )
        finally:
            try:
                client.files.delete(name=uploaded.name)
            except Exception:
                pass

    raw_text = response.text
    blocks = _parse_json_response(raw_text)

    # Normalise: ensure required keys exist with sensible defaults
    normalised = []
    for i, b in enumerate(blocks):
        normalised.append({
            "clause_number": b.get("clause_number"),
            "heading": b.get("heading"),
            "content": b.get("content", ""),
            "block_type": b.get("block_type", "informational"),
            "table_data": b.get("table_data"),  # None for non-table blocks
            "parent_clause_number": b.get("parent_clause_number"),
            "depth": int(b.get("depth", 0)),
            "sort_order": i,
        })
    return normalised


def _normalize_doc_id(name: str) -> str:
    """
    Strip revision/edition/year suffixes so that "API 661, 7th Edition" and
    "API 661" both normalise to "api 661" for duplicate-detection.

    Patterns removed (case-insensitive, applied left-to-right):
      - Hyphen or colon + 4-digit year   "B31.3-2022", "ISO 9001:2015"
      - Parenthesised year               "NFPA 70 (2023)"
      - "Nth Edition" / "Nth Ed."        "API 661, 7th Edition"
      - "Edition N"                      uncommon but handled
      - "Rev N" / "Revision N"
      - Trailing standalone 4-digit year ", 2020"
    """
    n = name.strip()
    n = re.sub(r'[-:]\d{4}\b.*$', '', n)                                          # -2022 / :2015
    n = re.sub(r'\s*\(\d{4}\).*$', '', n)                                         # (2023)
    n = re.sub(r',?\s+\d{1,2}(st|nd|rd|th)\s+ed(ition|\.?).*$', '', n, flags=re.IGNORECASE)  # 7th Ed
    n = re.sub(r',?\s+edition\s+\d+.*$', '', n, flags=re.IGNORECASE)              # Edition 3
    n = re.sub(r',?\s+rev(ision)?\.?\s*\d*\b.*$', '', n, flags=re.IGNORECASE)    # Rev 2
    n = re.sub(r',?\s+\d{4}$', '', n)                                             # trailing year
    return n.strip().lower()


def detect_document_references(block_texts: list[str]) -> list[dict]:
    """
    Ask Gemini to identify all external document references in a list of block
    content strings.  Returns a list of dicts with keys:
      document_number  — base ID without revision (e.g. "API 661")
      full_reference   — as written in the text (e.g. "API 661, 7th Edition")
      context          — short phrase e.g. "per API 661 §5.1"

    Caps input at ~100 000 characters to stay within model context limits.
    Reference sections are typically early in a document, so leading blocks
    are the most important — we send them in order.
    """
    # Concatenate block text, capped at 100k chars
    combined = ""
    for text in block_texts:
        if len(combined) + len(text) > 100_000:
            break
        combined += text + "\n\n"

    if not combined.strip():
        return []

    client = _get_client()
    prompt = DETECT_REFS_USER_TEMPLATE.format(text=combined)

    try:
        response = _generate_with_retry(
            client,
            model=MODEL,
            contents=[
                types.Content(
                    role="user",
                    parts=[types.Part(text=prompt)],
                )
            ],
            config=types.GenerateContentConfig(
                system_instruction=DETECT_REFS_SYSTEM,
            ),
        )
        raw = response.text or ""
        refs = _parse_json_response(raw)
    except Exception as e:
        # Reference detection is best-effort — don't fail the decomposition
        print(f"[detect_refs] WARNING: reference detection failed: {e}")
        return []

    normalised = []
    seen: set[str] = set()
    for r in refs:
        doc_num = str(r.get("document_number", "")).strip()
        if not doc_num:
            continue
        norm = _normalize_doc_id(doc_num)
        if norm in seen or not norm:
            continue
        seen.add(norm)
        normalised.append({
            "document_number": doc_num,
            "normalized": norm,
            "full_reference": str(r.get("full_reference", doc_num)).strip(),
            "context": str(r.get("context", "")).strip() or None,
        })
    return normalised


def extract_requirements(blocks: list[dict]) -> list[dict]:
    """
    Send a list of block dicts to Gemini and return extraction candidates.

    Each returned dict has:
      title, statement, source_clause, suggested_classification,
      suggested_discipline, source_block_index
    """
    client = _get_client()

    # Build a compact representation for the prompt
    blocks_for_prompt = [
        {
            "index": i,
            "clause_number": b.get("clause_number"),
            "block_type": b.get("block_type"),
            "content": b.get("content", ""),
        }
        for i, b in enumerate(blocks)
    ]
    blocks_json = json.dumps(blocks_for_prompt, indent=2)
    prompt = EXTRACT_USER_TEMPLATE.format(blocks_json=blocks_json)

    response = _generate_with_retry(
        client,
        model=MODEL,
        contents=[
            types.Content(
                role="user",
                parts=[types.Part(text=prompt)],
            )
        ],
        config=types.GenerateContentConfig(
            system_instruction=EXTRACT_SYSTEM,
        ),
    )

    raw_text = response.text
    candidates = _parse_json_response(raw_text)

    # Normalise
    normalised = []
    for c in candidates:
        normalised.append({
            "title": str(c.get("title", ""))[:120],
            "statement": c.get("statement", ""),
            "source_clause": c.get("source_clause"),
            "suggested_classification": c.get("suggested_classification", "Requirement"),
            "suggested_discipline": c.get("suggested_discipline", "General"),
            "source_block_index": int(c.get("source_block_index", 0)),
        })
    return normalised
