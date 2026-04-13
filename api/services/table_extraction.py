"""
pdfplumber-based table extraction pre-processor.

Extracts text and tables from each PDF page, returning the full document as
a single text string with tables serialized as envelope-wrapped Markdown blocks.

Gemini receives this text instead of the raw PDF, so it can output coherent
`table_block` entries rather than fragmenting tables row-by-row.

Falls back gracefully (returns None) when:
  - pdfplumber is unavailable
  - The PDF is image-based / scanned (no extractable text)
  - Any unexpected parsing error occurs
"""

from __future__ import annotations

import io
from typing import Optional


def extract_content_with_tables(pdf_bytes: bytes) -> Optional[str]:
    """
    Extract text + structured tables from a PDF using pdfplumber.

    Returns a single text string with tables wrapped in [TABLE BLOCK] markers,
    or None if the PDF appears to be scanned / image-only (no extractable text)
    or if pdfplumber encounters an unrecoverable error.
    """
    try:
        import pdfplumber  # type: ignore[import]
    except ImportError:
        return None

    sections: list[str] = []

    try:
        with pdfplumber.open(io.BytesIO(pdf_bytes)) as pdf:
            for page_num, page in enumerate(pdf.pages, start=1):
                page_parts: list[str] = []

                # Detect all tables on this page
                tables = page.find_tables()

                if tables:
                    table_bboxes = [t.bbox for t in tables]

                    # Extract prose text excluding objects that fall within
                    # table bounding boxes (±2 pt tolerance for rounding)
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

                    # Serialize each table as envelope-wrapped Markdown
                    for table in tables:
                        rows = table.extract()
                        if not rows:
                            continue
                        md = _rows_to_markdown(rows)
                        if md:
                            page_parts.append(
                                f"[TABLE BLOCK — Page {page_num}]\n{md}\n[END TABLE BLOCK]"
                            )
                else:
                    # No tables detected — extract full prose text for this page
                    prose = page.extract_text() or ""
                    if prose.strip():
                        page_parts.append(prose.strip())

                if page_parts:
                    sections.append(
                        f"=== Page {page_num} ===\n" + "\n\n".join(page_parts)
                    )

    except Exception as e:
        print(f"[table_extraction] WARNING: pdfplumber failed: {e}")
        return None

    full_text = "\n\n".join(sections)

    # Return None if we got almost no text — likely a scanned/image-only PDF.
    # The caller will fall back to the Gemini File API for those.
    if len(full_text.strip()) < 200:
        return None

    return full_text


def _rows_to_markdown(rows: list[list]) -> str:
    """
    Convert a pdfplumber table (list of rows, each a list of cell values)
    into a Markdown table string.

    Handles:
    - None cells (merged / empty cells) → empty string
    - Multi-line cell text → collapsed to single line
    - Ragged rows (merged-column cells) → padded to max width
    """
    if not rows:
        return ""

    # Normalise cells: None → "", strip whitespace, collapse newlines
    cleaned: list[list[str]] = [
        [str(cell or "").strip().replace("\n", " ") for cell in row]
        for row in rows
    ]

    max_cols = max((len(r) for r in cleaned), default=0)
    if max_cols == 0:
        return ""

    # Pad ragged rows to uniform width
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
