from __future__ import annotations

from uuid import uuid4

import pytest

from taxops_agents.agents.reconciliation import ReconciliationAgent
from taxops_agents.agents.reconciliation.rules import currency_of, load, reconcile, side_of
from taxops_agents.agents.validation import ValidationAgent
from taxops_agents.contract import RelatedProposal, RelatedSet, RunContext
from taxops_agents.events import ProposalAccepted
from taxops_agents.llm import FakeGateway

LETTER = ("BALANCE CONFIRMATION Northwind France SAS (the Company) hereby confirms the balance owed to Northwind GmbH as at 31 December 2025. "
          "Intercompany payable: EUR 340,000.00 (invoice dated 2025-11-30). Signed on behalf of Northwind France SAS.")


def tb_proposal(rows, sheet="NWG - EUR", currency="EUR", name="germany.xlsx") -> RelatedProposal:
    rr = [{"position": i + 1, "sheet": sheet, "source_row": i + 5, "values": {"account_code": c, "account_name": n, "debit": d, "credit": cr},
           "cells": {"account_code": f"A{i + 5}", "debit": f"C{i + 5}", "credit": f"D{i + 5}"}, "issues": []} for i, (c, n, d, cr) in enumerate(rows)]
    meta = {"currency": currency} if currency else {}
    return RelatedProposal(id=uuid4(), schema_key="trial_balance", payload={"sheet": sheet, "metadata": meta}, file_name=name, item_title="Trial balance", rows=rr)


def doc_proposal(amounts, excerpt=LETTER, doc_type="Balance confirmation", name="letter.pdf") -> RelatedProposal:
    return RelatedProposal(id=uuid4(), schema_key="supporting_document", payload={"document_type": doc_type, "excerpt": excerpt, "facts": {"amounts": amounts}},
                           file_name=name, item_title="Signed confirmation")


PAYABLE_BOOKS = [("1000", "Cash", "500000", "0"), ("2500", "Intercompany payable - Northwind France SAS", "0", "340000"), ("3000", "Capital", "0", "160000")]
RECEIVABLE_BOOKS = [("1000", "Cash", "160000", "0"), ("1500", "Intercompany receivable - Northwind France SAS", "340000", "0"), ("3000", "Capital", "0", "500000")]


def rules_of(drafts):
    return [d.rule_id for d in drafts]


def test_the_reversed_direction_in_our_sample_is_caught_and_the_assumption_is_stated():
    d = reconcile(load([tb_proposal(PAYABLE_BOOKS), doc_proposal(["EUR 340,000.00"])]))
    assert rules_of(d) == ["rc_direction"]
    f = d[0]
    assert f.severity == "warning" and f.metrics["document_side"] == "payable" and f.metrics["account_side"] == "payable"
    assert f.evidence and f.evidence[0]["row"] == 6 and "C6" in f.evidence[0]["cells"] or "D6" in f.evidence[0]["cells"]
    assert "cannot tell which entity a trial balance belongs to" in f.suggestion          # it does not pretend to know


def test_opposite_sides_agree_and_the_agreement_is_recorded():
    d = reconcile(load([tb_proposal(RECEIVABLE_BOOKS), doc_proposal(["EUR 340,000.00"])]))
    assert rules_of(d) == ["rc_agreement"] and d[0].severity == "info" and d[0].metrics["direction_checked"] is True


def test_an_amount_the_books_do_not_have_is_flagged_with_exact_arithmetic():
    d = reconcile(load([tb_proposal(PAYABLE_BOOKS), doc_proposal(["EUR 341,000.00"])]))
    assert rules_of(d) == ["rc_amount_unmatched"] and d[0].metrics["amount"] == "341000" and d[0].metrics["compared"] == ["NWG - EUR"]
    # a cent off is still unmatched at the default (exact) tolerance, and matched when a tolerance is set
    assert rules_of(reconcile(load([tb_proposal(PAYABLE_BOOKS), doc_proposal(["EUR 340,000.01"])]))) == ["rc_amount_unmatched"]
    data = load([tb_proposal(RECEIVABLE_BOOKS), doc_proposal(["EUR 340,000.01"])])
    data.settings = {"rc_amount_unmatched": {"enabled": True, "params": {"tolerance": "0.05"}}}
    assert rules_of(reconcile(data)) == ["rc_agreement"]


def test_different_currencies_are_never_compared_numerically():
    d = reconcile(load([tb_proposal(PAYABLE_BOOKS, currency="MXN"), doc_proposal(["EUR 340,000.00"])]))
    assert rules_of(d) == ["rc_currency"]                      # same number, different currency: not an agreement
    assert "MXN" in d[0].summary and "EUR" in d[0].summary
    # unknown currency on the books side: compare, but do not claim a currency mismatch
    assert rules_of(reconcile(load([tb_proposal(RECEIVABLE_BOOKS, currency=None), doc_proposal(["EUR 340,000.00"])]))) == ["rc_agreement"]


def test_only_balance_confirmations_and_only_when_both_sides_exist():
    assert reconcile(load([tb_proposal(PAYABLE_BOOKS), doc_proposal(["EUR 340,000.00"], doc_type="Invoice")])) == []
    assert load([doc_proposal(["EUR 340,000.00"])]).tbs == []


def test_an_account_without_a_named_counterparty_gets_no_direction_verdict():
    books = [("1000", "Cash", "500000", "0"), ("2500", "Intercompany payable", "0", "340000"), ("3000", "Capital", "0", "160000")]
    assert rules_of(reconcile(load([tb_proposal(books), doc_proposal(["EUR 340,000.00"])]))) == ["rc_agreement"]


def test_the_rules_can_be_switched_off_individually():
    data = load([tb_proposal(PAYABLE_BOOKS), doc_proposal(["EUR 340,000.00"])])
    data.settings = {"rc_direction": {"enabled": False, "params": {}}}
    assert rules_of(reconcile(data)) == ["rc_agreement"]      # direction off: the amount still agrees
    data.settings["rc_agreement"] = {"enabled": False, "params": {}}
    assert reconcile(data) == []


def test_helpers():
    assert currency_of("EUR 1,000.00") == "EUR" and currency_of("S$1,000") == "SGD" and currency_of("$1,000") is None and currency_of("¥5") is None
    assert side_of("Intercompany payable") == "payable" and side_of("balance owed by the buyer") == "receivable" and side_of("both payable and receivable") is None


class FakeRelated:
    def __init__(self, rel): self.rel = rel
    def related(self, proposal_id): return self.rel


def run_agent(proposals, self_id=None, settings=None):
    self_id = self_id or proposals[0].id
    rel = RelatedSet(self_id=self_id, request_reference="TX-1", tax_year=2025, rule_settings=settings or {}, external_llm_enabled=False, proposals=proposals)
    ctx = RunContext(tenant_id=uuid4(), run_id=uuid4(), triggered_by_event="proposal.accepted", llm=FakeGateway(), related=FakeRelated(rel))
    payload = ProposalAccepted.model_validate({"proposalId": self_id, "fileId": uuid4(), "requestId": uuid4(), "itemId": uuid4(), "schema": "trial_balance"})
    return ReconciliationAgent().run(ctx, payload), payload


def test_the_agent_turns_drafts_into_findings_that_reference_the_job_proposal():
    tb, doc = tb_proposal(PAYABLE_BOOKS), doc_proposal(["EUR 340,000.00"])
    res, payload = run_agent([tb, doc], self_id=doc.id)
    assert res.meta.status == "succeeded" and res.meta.llm_calls == 0 and res.meta.model is None
    p = res.proposals[0]
    assert p.kind == "finding" and p.rule_id == "rc_direction" and p.source_proposal_id == payload.proposalId
    assert p.payload["schema"] == "reconciliation" and p.payload["explanation_source"] == "template" and p.payload["source_proposal_id"] == str(payload.proposalId)
    assert p.payload["sheet"] == "NWG - EUR" and p.evidence


def test_the_agent_says_what_is_missing_instead_of_raising_nothing_silently():
    res, _ = run_agent([tb_proposal(PAYABLE_BOOKS)])
    assert res.meta.status == "skipped" and "no accepted balance confirmation" in res.meta.detail and res.proposals == []
    res, _ = run_agent([doc_proposal(["EUR 1.00"])])
    assert "no accepted trial balance" in res.meta.detail


def test_the_agent_and_validation_split_the_work_by_document_kind():
    doc_event = ProposalAccepted.model_validate({"proposalId": uuid4(), "fileId": uuid4(), "requestId": uuid4(), "itemId": uuid4(), "schema": "supporting_document"})
    tb_event = ProposalAccepted.model_validate({"proposalId": uuid4(), "fileId": uuid4(), "requestId": uuid4(), "itemId": uuid4(), "schema": "trial_balance"})
    assert ValidationAgent.accepts(doc_event) is False and ValidationAgent.accepts(tb_event) is True
    assert ReconciliationAgent.accepts(doc_event) is True and ReconciliationAgent.accepts(tb_event) is True


def test_the_agent_refuses_to_run_without_related_access():
    ctx = RunContext(tenant_id=uuid4(), run_id=uuid4(), triggered_by_event="proposal.accepted", llm=FakeGateway())
    payload = ProposalAccepted.model_validate({"proposalId": uuid4(), "fileId": uuid4(), "requestId": uuid4(), "itemId": uuid4(), "schema": "trial_balance"})
    with pytest.raises(RuntimeError):
        ReconciliationAgent().run(ctx, payload)


def test_a_proposal_that_is_not_the_jobs_own_yields_nothing():
    tb = tb_proposal(PAYABLE_BOOKS)
    rel = RelatedSet(self_id=tb.id, request_reference="TX-1", tax_year=2025, rule_settings={}, external_llm_enabled=False, proposals=[tb])
    ctx = RunContext(tenant_id=uuid4(), run_id=uuid4(), triggered_by_event="proposal.accepted", llm=FakeGateway(), related=FakeRelated(None))
    payload = ProposalAccepted.model_validate({"proposalId": uuid4(), "fileId": uuid4(), "requestId": uuid4(), "itemId": uuid4(), "schema": "trial_balance"})
    assert rel and ReconciliationAgent().run(ctx, payload).meta.status == "skipped"
