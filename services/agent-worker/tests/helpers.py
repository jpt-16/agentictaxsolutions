from __future__ import annotations

import io
from uuid import uuid4

from openpyxl import Workbook

from taxops_agents.contract import FileBlob, FileMeta, RunContext
from taxops_agents.llm import FakeGateway


def make_xlsx(sheets: dict[str, list[list]], hidden: tuple[str, ...] = ()) -> bytes:
    wb = Workbook()
    wb.remove(wb.active)
    for name, rows in sheets.items():
        ws = wb.create_sheet(name)
        for r in rows:
            ws.append(r)
        if name in hidden:
            ws.sheet_state = "hidden"
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


TB = [
    ["Account", "Description", "Debit", "Credit"],
    ["1000", "Cash", 1000, 0],
    ["1100", "Receivables", 500, 0],
    ["2000", "Payables", 0, 700],
    ["3000", "Equity", 0, 300],
    ["4000", "Revenue", 0, 1200],
    ["5000", "Expenses", 700, 0],
]


class FakeFiles:
    def __init__(self, data: bytes, name: str = "tb.xlsx", ai: bool = True, ext_llm: bool = True, content_type: str = "application/octet-stream") -> None:
        self.meta = FileMeta(
            tenant_id=uuid4(), file_id=uuid4(), request_id=uuid4(), item_id=uuid4(), submission_id=uuid4(), storage_key="k", sha256="0" * 64,
            original_name=name, content_type=content_type, size_bytes=len(data), ai_extraction_enabled=ai, external_llm_enabled=ext_llm,
        )
        self.data = data

    def open(self, file_id):
        return FileBlob(meta=self.meta, data=self.data)


def context(files: FakeFiles, gateway: FakeGateway | None = None, allow_llm: bool = True) -> tuple[RunContext, FakeGateway]:
    gw = gateway or FakeGateway()
    ctx = RunContext(tenant_id=files.meta.tenant_id, run_id=uuid4(), triggered_by_event="file.uploaded", llm=gw, files=files, allow_external_llm=allow_llm)
    return ctx, gw


def payload(files: FakeFiles, kind: str = "xlsx"):
    from taxops_agents.events import FileUploaded

    m = files.meta
    return FileUploaded(fileId=m.file_id, submissionId=m.submission_id, itemId=m.item_id, requestId=m.request_id, kind=kind)
