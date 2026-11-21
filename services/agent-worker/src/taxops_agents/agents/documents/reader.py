"""Reads text out of supporting documents (PDF, Word, plain text). Untrusted input: bounded, never executed.

Scanned (image-only) PDFs have no text layer; they yield no text and the agent says so instead of guessing (no OCR here).
"""
from __future__ import annotations

import io
import re
import zipfile
from dataclasses import dataclass, field

from defusedxml import ElementTree as ET
from defusedxml.common import DefusedXmlException

MAX_BYTES = 15 * 1024 * 1024
MAX_PAGES = 60
MAX_CHARS = 200_000
MAX_UNCOMPRESSED = 100 * 1024 * 1024
_W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"


class DocumentError(ValueError):
    pass


@dataclass
class DocText:
    text: str
    pages: int | None = None
    truncated: bool = False
    notes: list[str] = field(default_factory=list)


def _clean(s: str) -> str:
    s = s.replace("\x00", "")
    return re.sub(r"[ \t\r\f\v]+", " ", s).strip()


def _cap(text: str, notes: list[str]) -> tuple[str, bool]:
    if len(text) > MAX_CHARS:
        notes.append("The document is long; only the first part was read.")
        return text[:MAX_CHARS], True
    return text, False


def read_pdf(data: bytes) -> DocText:
    from pypdf import PdfReader  # imported lazily: only needed when a PDF arrives
    from pypdf.errors import PyPdfError

    try:
        reader = PdfReader(io.BytesIO(data))
        if reader.is_encrypted:
            raise DocumentError("The PDF is password-protected, so it could not be read.")
        total = len(reader.pages)
        parts: list[str] = []
        size = 0
        for page in reader.pages[:MAX_PAGES]:
            t = page.extract_text() or ""
            parts.append(t)
            size += len(t)
            if size > MAX_CHARS:
                break
    except DocumentError:
        raise
    except (PyPdfError, ValueError, KeyError, IndexError, TypeError, RecursionError, OSError):
        raise DocumentError("The PDF could not be read (damaged or unsupported).") from None
    notes: list[str] = []
    if total > MAX_PAGES:
        notes.append(f"Only the first {MAX_PAGES} of {total} pages were read.")
    text, trunc = _cap(_clean("\n".join(parts)), notes)
    if not text:
        notes.append("The PDF has no readable text (it may be a scan). Open the original to review it.")
    return DocText(text, total, trunc or total > MAX_PAGES, notes)


def read_docx(data: bytes) -> DocText:
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as z:
            if sum(i.file_size for i in z.infolist()) > MAX_UNCOMPRESSED:
                raise DocumentError("The document expands to an unsafe size.")
            raw = z.read("word/document.xml")
        root = ET.fromstring(raw)
    except DocumentError:
        raise
    except (zipfile.BadZipFile, KeyError, ET.ParseError, ValueError, DefusedXmlException):
        raise DocumentError("The Word document could not be read (damaged or unsupported).") from None
    paras = ["".join(t.text or "" for t in p.iter(f"{_W}t")) for p in root.iter(f"{_W}p")]
    notes: list[str] = []
    text, trunc = _cap(_clean("\n".join(x for x in paras if x.strip())), notes)
    return DocText(text, None, trunc, notes)


def read_txt(data: bytes) -> DocText:
    try:
        raw = data.decode("utf-8")
    except UnicodeDecodeError:
        raw = data.decode("latin-1")
    notes: list[str] = []
    text, trunc = _cap(_clean(raw), notes)
    return DocText(text, None, trunc, notes)


def read_text(kind: str, data: bytes) -> DocText:
    if len(data) > MAX_BYTES:
        raise DocumentError("The document is too large to read automatically.")
    if kind == "pdf":
        return read_pdf(data)
    if kind == "docx":
        return read_docx(data)
    if kind == "txt":
        return read_txt(data)
    raise DocumentError(f"No reader for {kind} files.")
