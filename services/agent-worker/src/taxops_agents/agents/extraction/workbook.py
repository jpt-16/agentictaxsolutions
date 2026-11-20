"""Reads spreadsheets into plain grids. Untrusted input: bounded in size, never executed, formulas never evaluated."""
from __future__ import annotations

import csv
import io
import zipfile
from dataclasses import dataclass, field
from datetime import date, datetime

MAX_ROWS = 20_000
MAX_COLS = 60
MAX_UNCOMPRESSED = 250 * 1024 * 1024


class WorkbookError(ValueError):
    pass


@dataclass
class Grid:
    name: str
    rows: list[list[object]]
    truncated: bool = False
    notes: list[str] = field(default_factory=list)


def col_letter(index: int) -> str:
    """0 -> A, 25 -> Z, 26 -> AA."""
    s, n = "", index + 1
    while n > 0:
        n, r = divmod(n - 1, 26)
        s = chr(65 + r) + s
    return s


def col_index(letter: str) -> int:
    n = 0
    for ch in letter.strip().upper():
        if not "A" <= ch <= "Z":
            raise ValueError(f"bad column {letter!r}")
        n = n * 26 + (ord(ch) - 64)
    return n - 1


def _check_zip(data: bytes) -> None:
    """The worker never trusts the upload-time checks: re-verify the container before parsing."""
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as z:
            infos = z.infolist()
            total = sum(i.file_size for i in infos)
            if len(infos) > 5000 or total > MAX_UNCOMPRESSED or total > max(len(data), 1) * 200:
                raise WorkbookError("Workbook expands to an unsafe size.")
    except zipfile.BadZipFile:
        raise WorkbookError("Workbook is not a valid XLSX file.") from None


def _clean(v: object) -> object:
    if isinstance(v, datetime):
        return v.date().isoformat() if v.time() == datetime.min.time() else v.isoformat(timespec="seconds")
    if isinstance(v, date):
        return v.isoformat()
    if isinstance(v, str):
        return v.strip()
    return v


def read_xlsx(data: bytes) -> list[Grid]:
    _check_zip(data)
    from openpyxl import load_workbook  # imported lazily: heavy, and only needed here

    try:
        wb = load_workbook(io.BytesIO(data), read_only=True, data_only=True)
    except Exception as e:  # noqa: BLE001 - any parser failure means "not a readable workbook"
        raise WorkbookError(f"Workbook could not be read ({type(e).__name__}).") from None
    grids: list[Grid] = []
    try:
        for ws in wb.worksheets:
            if getattr(ws, "sheet_state", "visible") != "visible":
                continue  # hidden sheets often hold scratch data; skip them
            rows: list[list[object]] = []
            truncated = False
            for r in ws.iter_rows(max_col=MAX_COLS, values_only=True):
                if len(rows) >= MAX_ROWS:
                    truncated = True
                    break
                row = [_clean(c) for c in r]
                while row and row[-1] in (None, ""):
                    row.pop()
                rows.append(row)
            while rows and not rows[-1]:
                rows.pop()
            grids.append(Grid(ws.title, rows, truncated))
    finally:
        wb.close()
    return grids


def read_csv(data: bytes) -> list[Grid]:
    try:
        text = data.decode("utf-8-sig")
    except UnicodeDecodeError:
        raise WorkbookError("CSV must be UTF-8 text.") from None
    sample = text[:4096]
    try:
        dialect = csv.Sniffer().sniff(sample, delimiters=",;\t|")
    except csv.Error:
        dialect = csv.excel
    rows: list[list[object]] = []
    truncated = False
    for r in csv.reader(io.StringIO(text), dialect):
        if len(rows) >= MAX_ROWS:
            truncated = True
            break
        row: list[object] = [c.strip() for c in r[:MAX_COLS]]
        while row and row[-1] == "":
            row.pop()
        rows.append(row)
    while rows and not rows[-1]:
        rows.pop()
    return [Grid("CSV", rows, truncated)]


def read_grids(data: bytes, kind: str) -> list[Grid]:
    if kind == "xlsx":
        return read_xlsx(data)
    if kind == "csv":
        return read_csv(data)
    raise WorkbookError(f"Unsupported file type for extraction: {kind}")
