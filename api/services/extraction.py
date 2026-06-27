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

# Decomposition is chunked by page so a large document never asks the model to
# emit more JSON than it can fit in one response.  Pages are grouped until the
# combined source text reaches this many characters, then a new chunk starts.
# Conservative versus the ~65k output-token ceiling because verbatim JSON output
# runs larger than the source text it is built from.
_MAX_DECOMPOSE_CHARS = 60_000

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


def _chunk_page_texts(page_texts: list[str], max_chars: int) -> list[str]:
    """
    Group per-page text sections into chunks whose combined length stays under
    *max_chars*, preserving page order.  Each chunk is a single string ready to
    drop into the decomposition prompt.

    A page section larger than max_chars on its own becomes its own (oversized)
    chunk — we never split a page mid-text, since that would risk cutting a clause
    or table marker in half.
    """
    chunks: list[str] = []
    current: list[str] = []
    current_len = 0
    for section in page_texts:
        sec_len = len(section)
        if current and current_len + sec_len > max_chars:
            chunks.append("\n\n".join(current))
            current = []
            current_len = 0
        current.append(section)
        current_len += sec_len
    if current:
        chunks.append("\n\n".join(current))
    return chunks


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def decompose_document(pdf_bytes: bytes) -> list[dict]:
    """
    Decompose a PDF into structured block dicts.

    Two-path approach:
    1. pdfplumber pre-processing (preferred): extracts text + batch-parses tables
       via Gemini Vision into [TABLE BLOCK] markers, then sends the text to Gemini
       in page-range chunks.  Each chunk is one request, so request count scales
       with document length, not table count, and no response risks the
       output-token truncation ceiling.
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
        chunks = _chunk_page_texts(page_texts, _MAX_DECOMPOSE_CHARS)
        print(
            f"[decompose] pdfplumber extracted {total_chars} chars across "
            f"{len(page_texts)} page(s) → {len(chunks)} decompose chunk(s) "
            f"({vision_count}/{len(table_map)} tables via vision)"
        )

        # Decompose each page-range chunk in its own call so no single response
        # has to fit the whole document under the output-token ceiling.  Blocks
        # are concatenated in document order; parent_clause_number links resolve
        # globally downstream regardless of which chunk a parent landed in.
        blocks: list[dict] = []
        for chunk_no, chunk_text in enumerate(chunks, start=1):
            if chunk_no > 1:
                # Space chunk calls out to stay under the per-minute request cap.
                time.sleep(_RETRY_DELAY_S)
            prompt = f"=== DOCUMENT CONTENT ===\n{chunk_text}\n\n{DECOMPOSE_USER}"
            response = _generate_with_retry(
                client,
                model=MODEL,
                contents=[
                    types.Content(role="user", parts=[types.Part(text=prompt)])
                ],
                config=types.GenerateContentConfig(
                    system_instruction=DECOMPOSE_SYSTEM,
                    response_mime_type="application/json",
                    max_output_tokens=_MAX_OUTPUT_TOKENS,
                    thinking_config=types.ThinkingConfig(thinking_budget=0),
                ),
            )
            chunk_blocks = _parse_json_response(response.text)
            print(
                f"[decompose] chunk {chunk_no}/{len(chunks)} → "
                f"{len(chunk_blocks)} block(s)"
            )
            blocks.extend(chunk_blocks)
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

    # Normalise: ensure required keys exist with sensible defaults.
    # sort_order is assigned globally across all chunks to preserve reading order.
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

    # ------------------------------------------------------------------
    # Inject pre-extracted vision table_data into table_block entries.
    #
    # The vision data is authoritative — it handles merged/multi-level
    # headers that the LLM text-parsing cannot recover.  We match by:
    #   1. Exact marker ID embedded in block.content  (primary)
    #   2. Positional order among table_blocks        (fallback)
    # ------------------------------------------------------------------
    if table_map:
        table_ids_in_order = list(table_map.keys())
        positional_index = 0

        for block in normalised:
            if block["block_type"] != "table_block":
                continue

            content = block.get("content", "")
            # Try exact match: look for "ID: TABLE_P3_I0" in content
            id_match = re.search(r"ID:\s*(TABLE_P\d+_I\d+)", content)
            if id_match and id_match.group(1) in table_map:
                block["table_data"] = table_map[id_match.group(1)]
            elif positional_index < len(table_ids_in_order):
                block["table_data"] = table_map[table_ids_in_order[positional_index]]

            positional_index += 1
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
