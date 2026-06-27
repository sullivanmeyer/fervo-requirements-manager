"""
pdfplumber + Gemini Vision table extraction pre-processor.

Pipeline:
  1. pdfplumber `find_tables()` — detect table bounding boxes on each page (fast,
     no API calls).
  2. Crop every detected table to a PNG at 200 DPI.
  3. Send the crops to Gemini Vision in BATCHES (many tables per request) rather
     than one request per table.  Vision returns structured JSON with multi-level
     headers (handles merged cells).  Batching is what keeps the request count —
     and therefore the requests-per-minute load — proportional to document length
     rather than to table count.
  4. Falls back to pdfplumber Markdown cell extraction for any table whose vision
     result is missing or unparseable.

`extract_content_with_tables` returns:
  (page_texts, table_map)

  page_texts — list of per-page strings (one entry per page that produced any
               content), each prefixed with "=== Page N ===".  Prose is kept
               verbatim and each table is replaced by a [TABLE BLOCK] marker that
               embeds the vision-extracted table_data inline so the downstream
               Gemini decomposition call can copy it verbatim.  Returned as a
               list (not one joined string) so the decomposition stage can group
               pages into size-bounded chunks.
               Returns None for scanned / image-only PDFs.

  table_map  — {marker_id: table_data_dict} in page/table order.
               The decomposition router uses this as an authoritative override:
               after the LLM produces blocks, any table_block whose content
               contains a known marker_id gets its table_data replaced with the
               pre-extracted version.
"""

from __future__ import annotations

import io
import json
import re
import time
from typing import Optional

# Retry config for vision API transient errors (503 UNAVAILABLE / 429 rate limit)
_VISION_MAX_RETRIES = 3
_VISION_RETRY_DELAYS = [5, 10, 20]  # seconds between attempts

# How many table images to send per Gemini Vision request.  Bounded by both the
# inline-request payload size (images are sent as base64) and the per-response
# output-token ceiling (each table returns a JSON object).  ~8 keeps both well
# within limits while cutting request count ~8x versus one-call-per-table.
_VISION_BATCH_SIZE = 8

# Brief pause between consecutive vision *batches* to avoid bursting Gemini's
# per-minute request limit on documents with many tables.
_INTER_BATCH_DELAY_S = 1.5


# ---------------------------------------------------------------------------
# Gemini Vision prompt
# ---------------------------------------------------------------------------

_VISION_BATCH_PROMPT = """\
You are given {n} images, each a table cropped from an engineering specification
document, provided in order (Table 1 through Table {n}).  Tables may have merged
header cells spanning multiple columns or rows (e.g. a "Vendor #1" header
spanning "Design Point", "Capacity Point", "Hot Point" sub-columns).

Return a JSON ARRAY of exactly {n} objects — one per image, in the same order.
Object i describes Table i.  Each object has exactly these keys:
{{
  "caption": "Table title text found above the table, or null",
  "headers": [
    ["", "", "Vendor #1", "Vendor #1", "Vendor #1"],
    ["Parameter", "Units", "Design Point", "Capacity Point", "Hot Point"]
  ],
  "rows": [
    ["Working Fluid", "", "Isopentane", "", ""],
    ["Ambient Temperature", "\\u00b0C", "13.6", "-10", "40"]
  ],
  "footnotes": "Any footnote / note text printed below the table body, or null"
}}

Rules:
- The output array MUST have exactly {n} elements in image order.  If an image is
  not a readable table, still emit an object for it with empty headers/rows.
- `headers` is always an array of arrays — one inner array per header row.
  A single-row header table still uses [["Col1", "Col2", ...]].
- Expand merged cells: repeat the parent value in every sub-column it spans.
- Preserve all numbers exactly (decimals, units, negative signs, em-dashes).
- If no caption is visible directly above a table, set caption to null.
- Return ONLY the JSON array — no prose, no code fences.
"""


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _is_transient(err: Exception) -> bool:
    """True for errors worth retrying: 503 overloaded or 429 rate-limited."""
    s = str(err)
    return (
        "503" in s
        or "UNAVAILABLE" in s
        or "429" in s
        or "RESOURCE_EXHAUSTED" in s
    )


def _crop_table_image(page, bbox: tuple, resolution: int = 200) -> Optional[bytes]:
    """
    Rasterise a table region from a pdfplumber page at the given DPI.
    Adds a small margin around the bounding box to capture borders and captions.
    Returns PNG bytes, or None if rendering fails.
    """
    try:
        from PIL import Image  # noqa: F401  (ensures Pillow is available)

        x0, y0, x1, y1 = bbox
        margin = 8  # points
        crop_bbox = (
            max(0.0, x0 - margin),
            max(0.0, y0 - margin),
            min(float(page.width), x1 + margin),
            min(float(page.height), y1 + margin),
        )
        cropped = page.crop(crop_bbox)
        img = cropped.to_image(resolution=resolution)
        buf = io.BytesIO()
        img.original.save(buf, format="PNG")
        return buf.getvalue()
    except Exception as e:
        print(f"[table_extraction] WARNING: rasterisation failed: {e}")
        return None


def _vision_extract_batch(
    images: list[bytes], gemini_client
) -> list[Optional[dict]]:
    """
    Send a batch of table PNGs to Gemini Vision in a SINGLE request and return a
    list of parsed table_data dicts aligned to `images` (same length, same order).

    Each returned dict uses `headers: string[][]` (multi-level).  Any element is
    None if Gemini's response is missing, the wrong length, or unparseable —
    callers fall back to pdfplumber Markdown for those.

    Retries up to _VISION_MAX_RETRIES times on transient (503/429) responses.
    """
    from google.genai import types  # type: ignore[import]

    n = len(images)
    if n == 0:
        return []

    # Interleave a text label before each image so the model can keep order even
    # if it reasons about images out of sequence.
    parts: list = [types.Part(text=_VISION_BATCH_PROMPT.format(n=n))]
    for i, img in enumerate(images, start=1):
        parts.append(types.Part(text=f"Table {i}:"))
        parts.append(types.Part.from_bytes(data=img, mime_type="image/png"))

    for attempt in range(_VISION_MAX_RETRIES):
        try:
            response = gemini_client.models.generate_content(
                model="gemini-2.5-flash",
                contents=[types.Content(role="user", parts=parts)],
                config=types.GenerateContentConfig(
                    response_mime_type="application/json",
                    max_output_tokens=65536,
                ),
            )

            raw = (response.text or "").strip()
            # Strip code fences if the model adds them despite response_mime_type
            fenced = re.search(r"```(?:json)?\s*([\s\S]*?)\s*```", raw)
            raw = fenced.group(1).strip() if fenced else raw

            # Locate the outermost JSON array
            start = raw.find("[")
            end = raw.rfind("]")
            if start == -1 or end == -1:
                raise ValueError("no JSON array in vision response")
            parsed = json.loads(raw[start : end + 1])

            if not isinstance(parsed, list):
                raise ValueError("vision response was not a JSON array")

            # Align to the requested count; pad/truncate defensively.
            out: list[Optional[dict]] = []
            for i in range(n):
                item = parsed[i] if i < len(parsed) else None
                if isinstance(item, dict):
                    headers = item.get("headers", [])
                    if headers and isinstance(headers[0], str):
                        item["headers"] = [headers]  # normalise to list-of-lists
                    out.append(item)
                else:
                    out.append(None)
            if len(parsed) != n:
                print(
                    f"[table_extraction] WARNING: vision returned {len(parsed)} "
                    f"objects for {n} tables — affected tables use fallback"
                )
            return out

        except Exception as e:
            if _is_transient(e) and attempt < _VISION_MAX_RETRIES - 1:
                delay = _VISION_RETRY_DELAYS[attempt]
                print(
                    f"[table_extraction] Vision transient error, retrying in "
                    f"{delay}s (attempt {attempt + 1}/{_VISION_MAX_RETRIES}): {e}"
                )
                time.sleep(delay)
            else:
                print(f"[table_extraction] WARNING: vision batch failed: {e}")
                return [None] * n

    return [None] * n


def _rows_to_markdown(rows: list[list]) -> str:
    """
    Convert pdfplumber table rows to a Markdown table string.
    Used only for the fallback path when vision extraction fails.
    """
    if not rows:
        return ""

    cleaned: list[list[str]] = [
        [str(cell or "").strip().replace("\n", " ") for cell in row]
        for row in rows
    ]
    max_cols = max((len(r) for r in cleaned), default=0)
    if max_cols == 0:
        return ""

    padded = [r + [""] * (max_cols - len(r)) for r in cleaned]
    header_row = padded[0]
    separator = ["---"] * max_cols

    lines: list[str] = [
        "| " + " | ".join(header_row) + " |",
        "| " + " | ".join(separator) + " |",
    ]
    for row in padded[1:]:
        lines.append("| " + " | ".join(row) + " |")
    return "\n".join(lines)


def _fallback_table_data(rows: list[list]) -> Optional[dict]:
    """Build a table_data dict from pdfplumber rows (used when vision is absent)."""
    if not rows:
        return None
    cleaned = [
        [str(c or "").strip().replace("\n", " ") for c in row]
        for row in rows
    ]
    max_cols = max((len(r) for r in cleaned), default=0)
    if max_cols == 0:
        return None
    padded = [r + [""] * (max_cols - len(r)) for r in cleaned]
    return {
        "caption": None,
        "headers": [padded[0]] if padded else [],
        "rows": padded[1:],
        "footnotes": None,
        "table_parse_quality": "fallback",
    }


def _render_table_marker(page_num: int, marker_id: str, table_data: dict) -> str:
    """Render a [TABLE BLOCK] marker with table_data embedded inline as JSON."""
    inline_json = json.dumps(table_data)
    return (
        f"[TABLE BLOCK — Page {page_num}, ID: {marker_id}]\n"
        f"TABLE_DATA: {inline_json}\n"
        f"[END TABLE BLOCK]"
    )


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def extract_content_with_tables(
    pdf_bytes: bytes,
    gemini_client=None,
) -> tuple[Optional[list[str]], dict[str, dict]]:
    """
    Extract structured text + table data from a PDF.

    Returns:
        (page_texts, table_map)

        page_texts — list of per-page strings (prose verbatim, tables replaced by
                     [TABLE BLOCK — Page N, ID: TABLE_PN_IX] markers with the
                     parsed table_data embedded inline under "TABLE_DATA:").
                     Returned as a list so the decomposition stage can group pages
                     into size-bounded chunks.  None for scanned / image-only PDFs.

        table_map  — {marker_id: table_data_dict} in document order.  Used by the
                     decomposition router as an authoritative override after the
                     LLM produces blocks.

    Table parsing strategy:
      * All table crops across the whole document are gathered first, then sent to
        Gemini Vision in batches of _VISION_BATCH_SIZE.  This makes the number of
        vision requests scale with table_count / batch_size instead of table_count.
      * When gemini_client is None (or a crop / vision result is unusable), the
        affected table falls back to pdfplumber Markdown serialisation with
        table_parse_quality='fallback'.
    """
    try:
        import pdfplumber  # type: ignore[import]
    except ImportError:
        return None, {}

    table_map: dict[str, dict] = {}

    # Per-page render plan: each page is a list of items that are either a literal
    # string (prose) or a ("table", marker_id) placeholder resolved after vision.
    page_plans: list[tuple[int, list]] = []

    # Crop jobs deferred for batched vision: marker_id → (page_num, png_bytes).
    crop_jobs: list[tuple[str, bytes]] = []
    # Fallback rows kept per marker so we can recover if vision is unavailable.
    fallback_rows: dict[str, list[list]] = {}

    try:
        with pdfplumber.open(io.BytesIO(pdf_bytes)) as pdf:
            for page_num, page in enumerate(pdf.pages, start=1):
                page_items: list = []
                tables = page.find_tables()

                if tables:
                    table_bboxes = [t.bbox for t in tables]

                    def _not_in_table(obj: dict) -> bool:
                        ox0 = obj.get("x0", 0)
                        ox1 = obj.get("x1", 0)
                        ot = obj.get("top", 0)
                        ob = obj.get("bottom", 0)
                        for (tx0, ty0, tx1, ty1) in table_bboxes:
                            if (
                                ox0 >= tx0 - 2
                                and ox1 <= tx1 + 2
                                and ot >= ty0 - 2
                                and ob <= ty1 + 2
                            ):
                                return False
                        return True

                    prose = page.filter(_not_in_table).extract_text() or ""
                    if prose.strip():
                        page_items.append(prose.strip())

                    for table_idx, table in enumerate(tables):
                        marker_id = f"TABLE_P{page_num}_I{table_idx}"
                        rows = table.extract()
                        if rows:
                            fallback_rows[marker_id] = rows

                        img_bytes = (
                            _crop_table_image(page, table.bbox)
                            if gemini_client is not None
                            else None
                        )
                        if img_bytes is not None:
                            crop_jobs.append((marker_id, img_bytes))

                        page_items.append(("table", marker_id))

                else:
                    prose = page.extract_text() or ""
                    if prose.strip():
                        page_items.append(prose.strip())

                if page_items:
                    page_plans.append((page_num, page_items))

    except Exception as e:
        print(f"[table_extraction] WARNING: pdfplumber failed: {e}")
        return None, {}

    # ------------------------------------------------------------------
    # Batched vision pass over all collected crops.
    # ------------------------------------------------------------------
    if crop_jobs and gemini_client is not None:
        total_batches = (len(crop_jobs) + _VISION_BATCH_SIZE - 1) // _VISION_BATCH_SIZE
        print(
            f"[table_extraction] {len(crop_jobs)} table(s) → "
            f"{total_batches} vision batch(es) of up to {_VISION_BATCH_SIZE}"
        )
        for batch_no, start in enumerate(range(0, len(crop_jobs), _VISION_BATCH_SIZE)):
            if batch_no > 0:
                time.sleep(_INTER_BATCH_DELAY_S)
            batch = crop_jobs[start : start + _VISION_BATCH_SIZE]
            results = _vision_extract_batch([img for _, img in batch], gemini_client)
            for (marker_id, _), data in zip(batch, results):
                if data is not None:
                    data["table_parse_quality"] = "vision"
                    table_map[marker_id] = data

    # ------------------------------------------------------------------
    # Fill in fallback table_data for any table vision didn't cover.
    # ------------------------------------------------------------------
    for marker_id, rows in fallback_rows.items():
        if marker_id not in table_map:
            fb = _fallback_table_data(rows)
            if fb is not None:
                table_map[marker_id] = fb

    # ------------------------------------------------------------------
    # Render each page plan into final text, resolving table placeholders.
    # ------------------------------------------------------------------
    page_texts: list[str] = []
    for page_num, items in page_plans:
        rendered: list[str] = []
        for item in items:
            if isinstance(item, tuple) and item[0] == "table":
                marker_id = item[1]
                td = table_map.get(marker_id)
                if td is not None and td.get("table_parse_quality") == "fallback":
                    # Fallback: embed Markdown rows rather than JSON so the LLM
                    # still sees the cell text.
                    md = _rows_to_markdown(fallback_rows.get(marker_id, []))
                    if md:
                        rendered.append(
                            f"[TABLE BLOCK — Page {page_num}, ID: {marker_id}]\n"
                            f"{md}\n"
                            f"[END TABLE BLOCK]"
                        )
                elif td is not None:
                    rendered.append(_render_table_marker(page_num, marker_id, td))
                # If no table_data at all (empty table), skip the marker entirely.
            else:
                rendered.append(item)

        if rendered:
            page_texts.append(f"=== Page {page_num} ===\n" + "\n\n".join(rendered))

    full_len = sum(len(p) for p in page_texts)
    if full_len < 200:
        return None, {}

    return page_texts, table_map
