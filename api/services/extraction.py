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

# Retry config for transient errors (503 overloaded / 429 rate-limited)
_MAX_RETRIES = 3
_RETRY_DELAY_S = 5

# Max output tokens for gemini-2.5-flash.  Set explicitly so long JSON responses
# are not silently truncated below the model's true ceiling.
_MAX_OUTPUT_TOKENS = 65536

# Block classification is sent in batches of this many blocks per request.  The
# model returns one small label object per block (not the text), so output stays
# tiny regardless of batch size — the limit is input size and the blast radius of
# a failed batch (which falls back to 'informational' defaults, never lost text).
# 120 keeps a ~250-block document to ~3 classification calls.
_CLASSIFY_BATCH_SIZE = 120

# Per-block text cap (chars) sent to the classifier.  Classification only needs
# the opening of a clause to spot SHALL/SHOULD/MAY or boilerplate, and the full
# verbatim text is preserved separately, so truncating the classifier's view is
# lossless and keeps request size down.
_CLASSIFY_TEXT_CAP = 1500

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
    content         : the full verbatim text of this block.
                      For table_block: include the marker line verbatim,
                      e.g. "[TABLE BLOCK — Page 3, ID: TABLE_P3_I0]"
    block_type      : one of:
                        "heading"            – section title, no substantive content
                        "requirement_clause" – contains SHALL / SHOULD / MAY obligations
                        "table_block"        – a complete table treated as one unit
                        "informational"      – explanatory or descriptive text
                        "boilerplate"        – TOC, revision history, signatures,
                                               distribution lists, legal notices
    table_data      : ONLY for table_block — either:
                        (a) If the marker contains "TABLE_DATA: {...}", copy that
                            JSON object verbatim as the table_data value.
                        (b) Otherwise parse the Markdown table and produce:
                            {
                              "caption": "Table title or null",
                              "headers": [["Col1", "Col2", ...]],
                              "rows": [["Cell", "Cell"], ...],
                              "context_note": "brief note on what this table specifies"
                            }
                            Note: headers is an array of arrays (even single-row).
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

Table block (pre-parsed TABLE_DATA path):
{
  "clause_number": "Table 3",
  "heading": "Design Parameters",
  "content": "[TABLE BLOCK — Page 2, ID: TABLE_P2_I0]",
  "block_type": "table_block",
  "table_data": {
    "caption": "Table 3 — Design Parameters",
    "headers": [["Parameter", "Value", "Unit"]],
    "rows": [["Design Pressure", "150", "psig"]],
    "context_note": "Specifies minimum design parameters for the pressure vessel"
  },
  "parent_clause_number": "5.3",
  "depth": 2
}
"""

CLASSIFY_SYSTEM = """\
You are an expert at classifying blocks of engineering specification text.
Your output must be valid JSON — no prose before or after the JSON array.
"""

CLASSIFY_USER_TEMPLATE = """\
You are given a JSON array of pre-segmented document blocks.  Each has:
  index         : integer identifier (unique within this batch)
  clause_number : the detected clause number, or null
  text          : the block's text (may be truncated — classify from what you see)

For EVERY block in the input, return one object with:
  index      : the SAME integer you were given
  block_type : one of
                 "heading"            – a section title with no substantive content
                 "requirement_clause" – contains SHALL / SHOULD / MAY obligations
                 "informational"      – explanatory or descriptive text
                 "boilerplate"        – table of contents, revision history,
                                        signatures, distribution lists, legal
                                        notices, or lists of referenced documents
  heading    : if block_type is "heading", the heading title text; otherwise null

Rules:
- Return an object for EVERY input index.  Do NOT skip any.  If unsure, classify
  the block as "informational".
- Do NOT echo the block text back — return only the small label object.
- Return ONLY a JSON array.

=== BLOCKS ===
{blocks_json}
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
- For table_block type blocks: examine the table_data (headers and rows) for
  specification data or requirement language. If the table specifies design parameters,
  performance criteria, material requirements, or other obligatory values, create ONE
  candidate for the entire table. The statement should be a concise 1-2 sentence
  description of what the table specifies (e.g. "Table 3 specifies the minimum design
  parameters for the pressure vessel including design pressure, temperature, and
  corrosion allowance."). Do not decompose table rows into separate candidates.
- For each extracted requirement include:
    title                             : concise human-readable summary (≤120 characters)
    statement                         : for prose blocks — the full, verbatim or lightly
                                        cleaned requirement text beginning with the subject
                                        ("The [subject] shall …"); for table_block —
                                        a 1-2 sentence description of what the table specifies
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


def _retry_delay(err: Exception, attempt: int) -> float:
    """
    Seconds to wait before the next retry.  Honours a 'retryDelay'/'retry-after'
    hint from a 429 RESOURCE_EXHAUSTED error when present; otherwise backs off
    geometrically from the base delay.
    """
    m = re.search(r"retry[-_ ]?(?:delay|after)['\"]?\s*[:=]\s*['\"]?(\d+)", str(err), re.IGNORECASE)
    if m:
        return float(m.group(1))
    return _RETRY_DELAY_S * (2 ** attempt)


def _generate_with_retry(client: genai.Client, **kwargs) -> Any:
    """
    Call generate_content with retry logic for transient errors:
      * 503 / UNAVAILABLE      — model temporarily overloaded
      * 429 / RESOURCE_EXHAUSTED — requests-per-minute limit hit
    Rate-limit errors back off (honouring any retry hint) instead of crashing.
    """
    last_exc = None
    for attempt in range(_MAX_RETRIES):
        try:
            return client.models.generate_content(**kwargs)
        except Exception as e:
            s = str(e)
            transient = (
                "503" in s or "UNAVAILABLE" in s
                or "429" in s or "RESOURCE_EXHAUSTED" in s
            )
            if transient:
                last_exc = e
                if attempt < _MAX_RETRIES - 1:
                    delay = _retry_delay(e, attempt)
                    print(f"[gemini] transient error, retrying in {delay:.0f}s: {e}")
                    time.sleep(delay)
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


# Markers and patterns used by deterministic segmentation.
_PAGE_HEADER_RE = re.compile(r"^=== Page (\d+) ===\s*$")
_TABLE_OPEN_RE = re.compile(r"^\[TABLE BLOCK — Page (\d+), ID: (TABLE_P\d+_I\d+)\]\s*$")
_TABLE_CLOSE = "[END TABLE BLOCK]"
# A clause number at the start of a line: "5", "5.3", "5.3.1", followed by a
# space, dot, paren, or colon (so "5.3 Pressure Vessels" matches but "5.3psig"
# and bare numeric data lines like "150" inside prose are less likely to).
_CLAUSE_START_RE = re.compile(r"^\s*(\d+(?:\.\d+){0,6})(?=[ .\):\t])")


def _derive_hierarchy(clause_number: str | None) -> tuple[str | None, int]:
    """
    Derive (parent_clause_number, depth) from a clause number, deterministically.
      "5"      → (None, 0)
      "5.3"    → ("5", 1)
      "5.3.1"  → ("5.3", 2)
    Blocks with no clause number are top-level (None, 0).
    """
    if not clause_number:
        return None, 0
    parts = clause_number.split(".")
    depth = len(parts) - 1
    parent = ".".join(parts[:-1]) if depth > 0 else None
    return parent, depth


def _segment_blocks(page_texts: list[str]) -> list[dict]:
    """
    Deterministically split the pdfplumber text into clause-aligned blocks WITHOUT
    any LLM involvement, so verbatim content is never dropped.

    A new prose block begins at each line that starts with a clause number; table
    markers become atomic table_block entries.  Page-header lines are stripped but
    never break a block, so a clause spanning a page boundary stays intact.

    Returns block dicts with keys:
      clause_number, content (verbatim), block_type (None for prose, "table_block"
      for tables), heading (None — set later by the classifier), marker_id, page,
      parent_clause_number, depth.
    """
    blocks: list[dict] = []
    cur_lines: list[str] = []
    cur_clause: str | None = None
    cur_page: int = 1

    def _flush():
        nonlocal cur_lines, cur_clause
        content = "\n".join(cur_lines).strip()
        if content:
            parent, depth = _derive_hierarchy(cur_clause)
            blocks.append({
                "clause_number": cur_clause,
                "content": content,
                "block_type": None,        # classified later
                "heading": None,
                "marker_id": None,
                "page": cur_page,
                "parent_clause_number": parent,
                "depth": depth,
            })
        cur_lines = []
        cur_clause = None

    for section in page_texts:
        lines = section.split("\n")
        i = 0
        while i < len(lines):
            line = lines[i]

            page_m = _PAGE_HEADER_RE.match(line)
            if page_m:
                cur_page = int(page_m.group(1))  # update page, don't break block
                i += 1
                continue

            table_m = _TABLE_OPEN_RE.match(line)
            if table_m:
                _flush()  # close any open prose block before the table
                marker_id = table_m.group(2)
                # Consume through the END marker; content is just the marker line
                # so the downstream table_data injection can match on the ID.
                blocks.append({
                    "clause_number": None,
                    "content": line.strip(),
                    "block_type": "table_block",
                    "heading": None,
                    "marker_id": marker_id,
                    "page": int(table_m.group(1)),
                    "parent_clause_number": None,
                    "depth": 0,
                })
                i += 1
                while i < len(lines) and lines[i].strip() != _TABLE_CLOSE:
                    i += 1
                i += 1  # skip the END marker line itself
                continue

            clause_m = _CLAUSE_START_RE.match(line)
            if clause_m:
                num = clause_m.group(1)
                rest = line[clause_m.end():].lstrip(" .):\t")
                # A dotted number ("5.3.1") is always a clause start; a bare
                # integer only counts if followed by a heading-like capitalised
                # word, so prose/data lines like "150 psig" don't false-trigger.
                is_clause_start = ("." in num) or rest[:1].isupper()
            else:
                is_clause_start = False

            if is_clause_start:
                if cur_lines or cur_clause is not None:
                    _flush()  # close the previous block before the new clause
                cur_clause = num

            cur_lines.append(line)
            i += 1

    _flush()
    return blocks


def _classify_blocks(client: genai.Client, blocks: list[dict]) -> None:
    """
    Assign block_type (and heading text) to each prose block IN PLACE via Gemini.

    The model receives only an index, clause number, and a capped text preview per
    block, and returns a small label object per index — it never reproduces text,
    so output stays small and complete.  Any block the model omits keeps a safe
    default ("informational"), so a block is never deleted, only possibly
    mislabelled.  table_block entries are skipped (their type is already known).
    """
    prose = [b for b in blocks if b["block_type"] != "table_block"]
    if not prose:
        return

    total_batches = (len(prose) + _CLASSIFY_BATCH_SIZE - 1) // _CLASSIFY_BATCH_SIZE
    print(f"[classify] {len(prose)} prose block(s) → {total_batches} batch(es)")

    for batch_no, start in enumerate(range(0, len(prose), _CLASSIFY_BATCH_SIZE), start=1):
        if batch_no > 1:
            time.sleep(_RETRY_DELAY_S)  # pace requests under the per-minute cap
        batch = prose[start : start + _CLASSIFY_BATCH_SIZE]
        payload = [
            {
                "index": idx,
                "clause_number": b["clause_number"],
                "text": b["content"][:_CLASSIFY_TEXT_CAP],
            }
            for idx, b in enumerate(batch)
        ]
        prompt = CLASSIFY_USER_TEMPLATE.format(blocks_json=json.dumps(payload, indent=2))

        # Default everything in the batch to informational first; the model's
        # answers override.  Anything it omits stays informational (never dropped).
        for b in batch:
            b["block_type"] = "informational"

        try:
            response = _generate_with_retry(
                client,
                model=MODEL,
                contents=[types.Content(role="user", parts=[types.Part(text=prompt)])],
                config=types.GenerateContentConfig(
                    system_instruction=CLASSIFY_SYSTEM,
                    response_mime_type="application/json",
                    max_output_tokens=_MAX_OUTPUT_TOKENS,
                    thinking_config=types.ThinkingConfig(thinking_budget=0),
                ),
            )
            labels = _parse_json_response(response.text)
        except Exception as e:
            print(f"[classify] WARNING: batch {batch_no} failed, keeping defaults: {e}")
            continue

        valid_types = {"heading", "requirement_clause", "informational", "boilerplate"}
        labelled = 0
        for label in labels:
            try:
                idx = int(label.get("index"))
            except (TypeError, ValueError):
                continue
            if 0 <= idx < len(batch):
                bt = label.get("block_type")
                if bt in valid_types:
                    batch[idx]["block_type"] = bt
                    labelled += 1
                if bt == "heading":
                    batch[idx]["heading"] = label.get("heading")
        print(f"[classify] batch {batch_no}/{total_batches} → {labelled}/{len(batch)} labelled")


def _inject_table_data(normalised: list[dict], table_map: dict[str, dict]) -> list[dict]:
    """
    Fill each table_block's table_data from the authoritative vision/fallback
    table_map.  Matches by the marker ID embedded in the block content first,
    then by positional order among table_blocks as a fallback.

    The vision data is authoritative — it handles merged/multi-level headers that
    text parsing cannot recover.  Mutates and returns *normalised*.
    """
    if not table_map:
        return normalised

    table_ids_in_order = list(table_map.keys())
    positional_index = 0

    for block in normalised:
        if block["block_type"] != "table_block":
            continue

        content = block.get("content", "")
        id_match = re.search(r"ID:\s*(TABLE_P\d+_I\d+)", content)
        if id_match and id_match.group(1) in table_map:
            block["table_data"] = table_map[id_match.group(1)]
        elif positional_index < len(table_ids_in_order):
            block["table_data"] = table_map[table_ids_in_order[positional_index]]

        positional_index += 1
    return normalised


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def decompose_document(pdf_bytes: bytes) -> list[dict]:
    """
    Decompose a PDF into structured block dicts.

    Two-path approach:
    1. pdfplumber pre-processing (preferred): extracts text + batch-parses tables
       via Gemini Vision.  The text is then segmented deterministically into
       clause-aligned blocks (no LLM), hierarchy is derived from clause numbers,
       and Gemini is asked ONLY to classify each block's type.  The model never
       reproduces text, so verbatim content can never be dropped — the failure
       mode where prose was silently summarised away is eliminated by design.
    2. File API fallback: for scanned / image-only PDFs where pdfplumber extracts
       no text, upload the raw PDF to Gemini's File API (vision-capable).  This
       path still has the model produce blocks verbatim, as there is no extracted
       text to segment.

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
    # Path 1: pdfplumber + Gemini Vision pre-processing
    # ------------------------------------------------------------------
    from services.table_extraction import extract_content_with_tables

    # Pass the Gemini client so table_extraction can batch-call the vision API
    # for table regions.  Returns (page_texts, table_map): page_texts is a list
    # of per-page strings; table_map maps marker IDs like "TABLE_P3_I0" →
    # pre-extracted table_data dicts.
    page_texts, table_map = extract_content_with_tables(
        pdf_bytes, gemini_client=client
    )

    if page_texts:
        vision_count = sum(
            1 for v in table_map.values()
            if v.get("table_parse_quality") == "vision"
        )
        total_chars = sum(len(p) for p in page_texts)

        # Deterministic segmentation owns the verbatim text + hierarchy; the LLM
        # only classifies each block.  Content is never reproduced by the model,
        # so it can never be dropped.
        blocks = _segment_blocks(page_texts)
        print(
            f"[decompose] pdfplumber extracted {total_chars} chars across "
            f"{len(page_texts)} page(s) → {len(blocks)} block(s) segmented "
            f"({vision_count}/{len(table_map)} tables via vision)"
        )
        _classify_blocks(client, blocks)

        # Normalise straight from the segmented blocks (already in the final
        # shape) and assign global sort_order, then return.
        normalised = []
        for i, b in enumerate(blocks):
            normalised.append({
                "clause_number": b.get("clause_number"),
                "heading": b.get("heading"),
                "content": b.get("content", ""),
                "block_type": b.get("block_type") or "informational",
                "table_data": None,  # filled by table_map injection below
                "parent_clause_number": b.get("parent_clause_number"),
                "depth": int(b.get("depth", 0)),
                "sort_order": i,
            })
        return _inject_table_data(normalised, table_map)
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
                    max_output_tokens=_MAX_OUTPUT_TOKENS,
                    thinking_config=types.ThinkingConfig(thinking_budget=0),
                ),
            )
        finally:
            try:
                client.files.delete(name=uploaded.name)
            except Exception:
                pass
        blocks = _parse_json_response(response.text)

    # Normalise the File-API (scanned-PDF) blocks, which the LLM still produces
    # verbatim since there is no pdfplumber text to segment.
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
    return _inject_table_data(normalised, table_map)


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

    # Build a compact representation for the prompt.
    # For table_block entries, include table_data so the LLM can see the
    # structured headers/rows rather than only raw Markdown pipe text.
    blocks_for_prompt = []
    for i, b in enumerate(blocks):
        entry: dict = {
            "index": i,
            "clause_number": b.get("clause_number"),
            "block_type": b.get("block_type"),
            "content": b.get("content", ""),
        }
        if b.get("block_type") == "table_block" and b.get("table_data"):
            entry["table_data"] = b["table_data"]
        blocks_for_prompt.append(entry)

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
            response_mime_type="application/json",
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
            "suggested_classification_subtype": c.get("suggested_classification_subtype"),
            "suggested_discipline": c.get("suggested_discipline", "General"),
            "source_block_index": int(c.get("source_block_index", 0)),
        })
    return normalised
