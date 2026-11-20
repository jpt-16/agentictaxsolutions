from __future__ import annotations

from uuid import uuid4

from helpers import FakeFiles, make_xlsx

from taxops_agents.agents.extraction import RemapAgent
from taxops_agents.contract import RunContext
from taxops_agents.events import ExtractionRemap
from taxops_agents.llm import FakeGateway

# Columns the matcher cannot read: the reviewer says A=code, B=name, C=debit, D=credit, header on row 2.
ODD = [["Q4 export"], ["Ledger ref", "Narrative", "Dr (EUR)", "Cr (EUR)"], ["1000", "Cash", 100, 0], ["2000", "Payables", 0, 100]]


def remap(files: FakeFiles, **over):
    pl = {"fileId": files.meta.file_id, "submissionId": files.meta.submission_id, "itemId": files.meta.item_id, "requestId": files.meta.request_id,
          "kind": "xlsx", "sheet": "S", "headerRow": 2, "columns": {"account_code": "A", "account_name": "B", "debit": "C", "credit": "D"}, "requestedBy": uuid4(), **over}
    gw = FakeGateway()
    ctx = RunContext(tenant_id=files.meta.tenant_id, run_id=uuid4(), triggered_by_event="extraction.remap", llm=gw, files=files)
    return RemapAgent().run(ctx, ExtractionRemap.model_validate(pl)), gw


def test_a_reviewer_mapping_is_applied_verified_and_marked_manual():
    res, gw = remap(FakeFiles(make_xlsx({"S": ODD})))
    p = res.proposals[0]
    assert gw.calls == [] and res.meta.status == "succeeded" and res.meta.llm_calls == 0
    assert p.payload["method"] == "manual" and p.payload["header_row"] == 2
    assert p.payload["columns"]["debit"] == {"letter": "C", "header": "Dr (EUR)"}
    assert [(r.values["account_code"], r.values["debit"], r.values["credit"]) for r in res.rows] == [("1000", "100", "0"), ("2000", "0", "100")]
    assert res.rows[0].cells["debit"] == "C3" and res.rows[0].source_row == 3
    assert any("reviewer" in n for n in p.payload["notes"]) and "reviewer-corrected" in p.detail


def test_a_mapping_that_does_not_match_the_data_is_refused_not_trusted():
    res, _ = remap(FakeFiles(make_xlsx({"S": ODD})), columns={"account_code": "A", "account_name": "B", "debit": "B", "credit": "A"})
    assert res.proposals == [] and res.meta.status == "failed" and "do not match the data" in res.meta.detail


def test_bad_references_fail_cleanly():
    f = FakeFiles(make_xlsx({"S": ODD}))
    assert "not found" in remap(f, sheet="Nope")[0].meta.detail
    assert "outside the sheet" in remap(f, headerRow=99)[0].meta.detail
    assert remap(f, columns={"account_code": "A1", "debit": "C", "credit": "D"})[0].meta.status == "failed"
    assert remap(f, columns={"account_code": "A", "debit": "C"})[0].meta.status == "failed"  # incomplete: no credit/balance
    assert remap(FakeFiles(b"junk"), kind="xlsx")[0].meta.status == "failed"


def test_signed_balance_mapping_works():
    rows = [["Ref", "Name", "Net"], ["1", "Cash", 50], ["2", "Pay", -50]]
    res, _ = remap(FakeFiles(make_xlsx({"S": rows})), headerRow=1, columns={"account_code": "A", "account_name": "B", "balance": "C"})
    assert [(r.values["debit"], r.values["credit"]) for r in res.rows] == [("50", "0"), ("0", "50")]
