"""
pdfplumber + Gemini Vision table extraction pre-processor.

Two-pass pipeline:
  1. pdfplumber `find_tables()` — detect table bounding boxes on each page (fast).
  2. For each table: crop the region to a PNG at 200 DPI and send to Gemini Vision.
     Vision returns structured JSON with multi-level headers (handles merged cells).
  3. Falls back to pdfplumber Markdown cell extraction when vision is unavailable
     or returns unparseable JSON.

`extract_content_with_tables` returns:
  (text, table_map)

  text      — the full document as a single string with prose kept verbatim and
              each table replaced by a [TABLE BLOCK] marker.  Markers embed the
              vision-extracted table_data inline so the downstream Gemini
              decomposition call can copy it verbatim rather than re-parse Markdown.
              Returns None for scanned / image-only PDFs.

  table_map — {marker_id: table_data_dict} in page/table order.
              The decomposition router uses this to inject accurate table_data
              into any table_block entries after the LLM runs.
"""

from __future__ import annotations

import io
import json
import re
import time
from typing import Optional

# Retry config for vision API 503s
_VISION_MAX_RETRIES = 3
_VISION_RETRY_DELAYS = [5, 10, 20]  # seconds between attempts

# Brief pause between consecutive table vision calls to avoid burst rate-limiting
_INTER_TABLE_DELAY_S = 1.5


# ---------------------------------------------------------------------------
# Gemini Vision prompt
# ---------------------------------------------------------------------------

_VISION_TABLE_PROMPT = """\
This is an image of a table from an engineering specification document.
The table may have merged header cells spanning multiple columns or rows
(e.g. a "Vendor #1" header spanning "Design Point", "Capacity Point",
"Hot Point" sub-columns).

Return the table as a JSON object with exactly these keys:
{
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
}

Rules:
- `headers` is always an array of arrays — one inner array per header row.
  A single-row header table still uses [["Col1", "Col2", ...]].
- Expand merged cells: repeat the parent value in every sub-column it spans.
- Preserve all numbers exactly (decimals, units, negative signs, em-dashes).
- If no caption is visible directly above the table, set caption to null.
- Return ONLY the JSON object — no prose, no code fences.
"""


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

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


def _vision_extract_table(image_bytes: bytes, gemini_client) -> Optional[dict]:
    """
    Send a table PNG to Gemini Vision and return a parsed table_data dict.
    The returned dict uses `headers: string[][]` (multi-level).
    Returns None if all retries fail or Gemini returns invalid JSON.

    Retries up to _VISION_MAX_RETRIES times on 503 UNAVAILABLE responses,
    with increasing delays between attempts.
    """
    from google.genai import types  # type: ignore[import]

    for attempt in range(_VISION_MAX_RETRIES):
        try:
            response = gemini_client.models.generate_content(
                model="gemini-2.5-flash",
                contents=[
                    types.Content(
                        role="user",
                        parts=[
                            types.Part.from_bytes(
                                data=image_bytes,
                                mime_type="image/png",
                            ),
                            types.Part(text=_VISION_TABLE_PROMPT),
                        ],
                    )
                ],
                config=types.GenerateContentConfig(
                    response_mime_type="application/json",
                ),
            )

            raw = (response.text or "").strip()
            # Strip code fences if the model adds them despite response_mime_type
            fenced = re.search(r"```(?:json)?\s*([\s\S]*?)\s*```", raw)
            raw = fenced.group(1).strip() if fenced else raw

            data = json.loads(raw)

            # Normalise: ensure headers is always a list of lists
            headers = data.get("headers", [])
            if headers and isinstance(headers[0], str):
                data["headers"] = [headers]

            return data

        except Exception as e:
            err_str = str(e)
            is_transient = "503" in err_str or "UNAVAILABLE" in err_str
            if is_transient and attempt < _VISION_MAX_RETRIES - 1:
                delay = _VISION_RETRY_DELAYS[attempt]
                print(
                    f"[table_extraction] Vision 503, retrying in {delay}s "
                    f"(attempt {attempt + 1}/{_VISION_MAX_RETRIES})"
                )
                time.sleep(delay)
            else:
                print(f"[table_extraction] WARNING: Gemini vision extraction failed: {e}")
                return None

    return None


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


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def extract_content_with_tables(
    pdf_bytes: bytes,
    gemini_client=None,
) -> tuple[Optional[str], dict[str, dict]]:
    """
    Extract structured text + table data from a PDF.

    Returns:
        (text, table_map)

        text      — Full document text with prose verbatim and tables replaced
                    by [TABLE BLOCK — Page N, ID: TABLE_PN_IX] markers.
                    Each marker embeds the pre-parsed table_data JSON inline
                    under a "TABLE_DATA:" prefix so the downstream Gemini call
                    can copy it without re-parsing Markdown.
                    Returns None if the PDF appears to be scanned / image-only.

        table_map — {marker_id: table_data_dict}  in document order.
                    Used by the decomposition router as an authoritative override:
                    after the LLM produces blocks, any table_block whose content
                    contains a known marker_id gets its table_data replaced with
                    the pre-extracted version.

    When gemini_client is None (or vision fails for all tables), falls back to
    pdfplumber Markdown serialisation and table_map still contains fallback
    table_data entries with table_parse_quality='fallback'.
    """
    try:
        import pdfplumber  # type: ignore[import]
    except ImportError:
        return None, {}

    table_map: dict[str, dict] = {}
    sections: list[str] = []

    try:
        with pdfplumber.open(io.BytesIO(pdf_bytes)) as pdf:
            for page_num, page in enumerate(pdf.pages, start=1):
                page_parts: list[str] = []
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
                        page_parts.append(prose.strip())

                    for table_idx, table in enumerate(tables):
                        marker_id = f"TABLE_P{page_num}_I{table_idx}"

                        # ── Vision extraction path ────────────────────────────
                        vision_data: Optional[dict] = None
                        if gemini_client is not None:
                            # Brief pause between consecutive calls to avoid
                            # bursting Gemini's rate limit when a document has
                            # many tables.
                            if table_idx > 0:
                                time.sleep(_INTER_TABLE_DELAY_S)
                            img_bytes = _crop_table_image(page, table.bbox)
                            if img_bytes:
                                vision_data = _vision_extract_table(
                                    img_bytes, gemini_client
                                )

                        if vision_data is not None:
                            vision_data["table_parse_quality"] = "vision"
                            table_map[marker_id] = vision_data
                            inline_json = json.dumps(vision_data)
                            page_parts.append(
                                f"[TABLE BLOCK — Page {page_num}, ID: {marker_id}]\n"
                                f"TABLE_DATA: {inline_json}\n"
                                f"[END TABLE BLOCK]"
                            )
                        else:
                            # ── Fallback: pdfplumber Markdown ─────────────────
                            rows = table.extract()
                            if rows:
                                md = _rows_to_markdown(rows)
                                if md:
                                    cleaned = [
                                        [
                                            str(c or "").strip().replace("\n", " ")
                                            for c in row
                                        ]
                                        for row in rows
                                    ]
                                    max_cols = max(
                                        (len(r) for r in cleaned), default=0
                                    )
                                    padded = [
                                        r + [""] * (max_cols - len(r))
                                        for r in cleaned
                                    ]
                                    fallback_data: dict = {
                                        "caption": None,
                                        "headers": [padded[0]] if padded else [],
                                        "rows": padded[1:],
                                        "footnotes": None,
                                        "table_parse_quality": "fallback",
                                    }
                                    table_map[marker_id] = fallback_data
                                    page_parts.append(
                                        f"[TABLE BLOCK — Page {page_num}, ID: {marker_id}]\n"
                                        f"{md}\n"
                                        f"[END TABLE BLOCK]"
                                    )

                else:
                    prose = page.extract_text() or ""
                    if prose.strip():
                        page_parts.append(prose.strip())

                if page_parts:
                    sections.append(
                        f"=== Page {page_num} ===\n" + "\n\n".join(page_parts)
                    )

    except Exception as e:
        print(f"[table_extraction] WARNING: pdfplumber failed: {e}")
        return None, {}

    full_text = "\n\n".join(sections)

    if len(full_text.strip()) < 200:
        return None, {}

    return full_text, table_map
