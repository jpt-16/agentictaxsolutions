from __future__ import annotations

import io
import zipfile

import pytest
from helpers import FakeFiles, context, payload

from taxops_agents.agents.documents import DocumentAgent
from taxops_agents.agents.documents.agent import DocFacts, KeyAmount, verify_llm_facts
from taxops_agents.agents.documents.facts import extract_facts
from taxops_agents.agents.documents.reader import DocumentError, read_text
from taxops_agents.llm import FakeGateway

CONFIRMATION = (
    "Balance confirmation\nNorthwind GmbH confirms the balance owed to Northwind Holdings Inc. as at 31 December 2025 "
    "was EUR 1,250,000.50 (invoice dated 2025-11-30). Signed on behalf of Northwind GmbH."
)


def make_docx(text: str) -> bytes:
    body = "".join(f"<w:p><w:r><w:t>{line}</w:t></w:r></w:p>" for line in text.split("\n"))
    xml = f'<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>{body}</w:body></w:document>'
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("word/document.xml", xml)
    return buf.getvalue()


def make_pdf(text: str) -> bytes:
    """A minimal one-page PDF with a real text layer (hand-built so the test needs no PDF writer)."""
    esc = text.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")
    stream = f"BT /F1 12 Tf 72 720 Td ({esc}) Tj ET".encode()
    objs = [b"<< /Type /Catalog /Pages 2 0 R >>", b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
            b"<< /Length " + str(len(stream)).encode() + b" >>\nstream\n" + stream + b"\nendstream", b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"]
    out = b"%PDF-1.4\n"
    offsets = []
    for i, o in enumerate(objs, 1):
        offsets.append(len(out))
        out += f"{i} 0 obj\n".encode() + o + b"\nendobj\n"
    xref = len(out)
    out += f"xref\n0 {len(objs) + 1}\n0000000000 65535 f \n".encode() + b"".join(f"{o:010d} 00000 n \n".encode() for o in offsets)
    out += f"trailer\n<< /Size {len(objs) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF".encode()
    return out


def run(data: bytes, name: str, kind: str, gw=None, allow=False, ai=True):
    files = FakeFiles(data, name=name, ai=ai)
    ctx, g = context(files, gw, allow)
    return DocumentAgent().run(ctx, payload(files, kind)), g


def test_text_docx_and_pdf_yield_the_same_deterministic_facts_without_any_model():
    for data, name, kind in ((CONFIRMATION.encode(), "c.txt", "txt"), (make_docx(CONFIRMATION), "c.docx", "docx")):
        res, gw = run(data, name, kind)
        assert gw.calls == [] and res.meta.llm_calls == 0 and res.meta.status == "succeeded"
        p = res.proposals[0]
        assert p.kind == "extraction" and p.payload["schema"] == "supporting_document" and p.payload["document_type"] == "Balance confirmation"
        assert "EUR 1,250,000.50" in p.payload["facts"]["amounts"] and "2025-11-30" in p.payload["facts"]["dates"] and "31 December 2025" in p.payload["facts"]["dates"]
        assert p.payload["facts"]["signature_cues"] >= 1 and p.confidence >= 0.7
    pdf = run(make_pdf("Balance confirmation EUR 1,250,000.50 signed 2025-11-30"), "c.pdf", "pdf")[0].proposals[0]
    assert "EUR 1,250,000.50" in pdf.payload["facts"]["amounts"] and pdf.payload["stats"]["pages"] == 1


def test_a_pdf_with_no_text_is_reported_honestly_and_gets_low_confidence():
    res, _ = run(make_pdf(""), "scan.pdf", "pdf")
    p = res.proposals[0]
    assert p.confidence <= 0.3 and any("no readable text" in n for n in p.payload["notes"])


def test_the_agent_declines_spreadsheets_and_respects_the_tenant_switch():
    files = FakeFiles(b"x", name="a.xlsx")
    assert DocumentAgent.accepts(payload(files, "xlsx")) is False and DocumentAgent.accepts(payload(files, "pdf")) is True
    res, _ = run(CONFIRMATION.encode(), "c.txt", "txt", ai=False)
    assert res.meta.status == "skipped" and res.proposals == []


def test_damaged_and_hostile_files_fail_cleanly():
    for kind, data in (("pdf", b"%PDF-1.4 garbage"), ("docx", b"not a zip"), ("pdf", b"x" * (16 * 1024 * 1024))):
        with pytest.raises(DocumentError):
            read_text(kind, data)
    res, _ = run(b"not a zip", "x.docx", "docx")
    assert res.meta.status == "failed" and res.proposals == []
    xxe = b'<?xml version="1.0"?><!DOCTYPE d [<!ENTITY x SYSTEM "file:///etc/passwd">]><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>&x;</w:t></w:r></w:p></w:body></w:document>'
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("word/document.xml", xxe)
    with pytest.raises(DocumentError):
        read_text("docx", buf.getvalue())


def test_model_output_is_kept_only_when_the_document_supports_it():
    ans = DocFacts(summary="Confirms a balance of 1,250,000.50.", counterparty="Northwind GmbH", period="31 December 2025",
                   key_amounts=[KeyAmount(label="Balance", value="EUR 1,250,000.50"), KeyAmount(label="Invented", value="EUR 9,999")])
    res, gw = run(CONFIRMATION.encode(), "c.txt", "txt", gw=FakeGateway([ans]), allow=True)
    p = res.proposals[0]
    assert res.meta.llm_calls == 1 and p.payload["summary_source"] == "llm" and p.payload["counterparty"] == "Northwind GmbH"
    assert [a["value"] for a in p.payload["key_amounts"]] == ["EUR 1,250,000.50"]
    assert any("9,999" not in n and "not in the document" in n for n in p.payload["notes"])
    assert "<document>" in gw.calls[0]


def test_a_summary_with_an_invented_figure_or_name_is_dropped():
    g, dropped = verify_llm_facts(DocFacts(summary="Balance is 777.", counterparty="Acme Corp"), CONFIRMATION)
    assert g.summary == "" and g.counterparty == "" and len(dropped) == 2


def test_no_model_call_when_the_tenant_has_not_allowed_it():
    res, gw = run(CONFIRMATION.encode(), "c.txt", "txt", gw=FakeGateway([DocFacts(summary="x")]), allow=False)
    assert gw.calls == [] and res.meta.llm_calls == 0 and res.proposals[0].payload["summary_source"] == "none"


def test_fact_patterns():
    f = extract_facts("Total $1,200.00 and 500 USD due 3 March 2025; also FY2024, 03/04/2025. Sincerely, A.")
    assert "$1,200.00" in f.amounts and "500 USD" in f.amounts and "3 March 2025" in f.dates and "03/04/2025" in f.dates
    assert f.years == ["2024", "2025"] and f.signature_cues == 1


def test_output_matches_the_golden_fixture_shared_with_the_typescript_app():
    import json
    from pathlib import Path

    golden = json.loads((Path(__file__).resolve().parents[3] / "schemas/fixtures/document_proposal.json").read_text())
    got = run(CONFIRMATION.encode(), "confirmation.txt", "txt")[0].proposals[0].payload
    got["file_id"] = golden["file_id"]
    assert got == golden
