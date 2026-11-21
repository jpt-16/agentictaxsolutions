from __future__ import annotations

import json
import os
from pathlib import Path
from uuid import uuid4

from taxops_agents.agents.validation import ValidationAgent, rule_catalog
from taxops_agents.agents.validation.agent import Explanation, Explanations
from taxops_agents.agents.validation.rules import Row, TBData, run_rules
from taxops_agents.catalog import rule_catalog as full_catalog
from taxops_agents.contract import RunContext, SourceProposal
from taxops_agents.events import ProposalAccepted
from taxops_agents.llm import FakeGateway, NullGateway


def rows(spec: list[tuple]) -> list[dict]:
    """spec: (code, name, debit, credit)"""
    out = []
    for i, (code, name, d, c) in enumerate(spec):
        r = i + 2
        out.append({"position": i + 1, "sheet": "S", "source_row": r, "values": {"account_code": code, "account_name": name, "debit": str(d), "credit": str(c)},
                    "cells": {"account_code": f"A{r}", "debit": f"C{r}", "credit": f"D{r}"}, "issues": []})
    return out


GOOD = [("1000", "Cash", 100, 0), ("1100", "Receivables", 50, 0), ("2000", "Payables", 0, 60), ("3000", "Share capital", 0, 40),
        ("4000", "Revenue", 0, 200), ("5000", "Cost of sales", 150, 0)]  # debits 300 = credits 300


class FakeProposals:
    def __init__(self, src: SourceProposal | None) -> None:
        self.src = src

    def open(self, proposal_id):
        return self.src


def source(spec, settings=None, stats=None, ext=False, schema="trial_balance") -> SourceProposal:
    return SourceProposal(id=uuid4(), schema_key=schema, payload={"sheet": "S", "stats": stats or {}, "metadata": {}}, rows=rows(spec),
                          rule_settings=settings or {}, external_llm_enabled=ext, request_reference="TX-1", tax_year=2025)


def run(src: SourceProposal | None, gw=None, allow=False):
    gw = gw or FakeGateway()
    ctx = RunContext(tenant_id=uuid4(), run_id=uuid4(), triggered_by_event="proposal.accepted", llm=gw, proposals=FakeProposals(src), allow_external_llm=allow)
    pid = src.id if src else uuid4()
    pl = ProposalAccepted.model_validate({"proposalId": pid, "fileId": uuid4(), "requestId": uuid4(), "itemId": uuid4(), "schema": "trial_balance"})
    return ValidationAgent().run(ctx, pl), gw


def rule_ids(res) -> list[str]:
    return [p.rule_id for p in res.proposals]


def test_a_clean_trial_balance_raises_nothing_and_says_so():
    res, gw = run(source(GOOD))
    assert res.proposals == [] and res.meta.status == "succeeded" and "no findings" in res.meta.detail and gw.calls == []


def test_footing_flags_the_difference_with_exact_arithmetic_and_helpful_hints():
    spec = [*GOOD[:-1], ("5000", "Cost of sales", "150.10", 0)]
    res, _ = run(source(spec))
    f = res.proposals[0]
    assert f.rule_id == "tb_footing" and f.severity == "error" and f.confidence == 1.0 and f.title == "Debits and credits differ by 0.1"
    assert f.payload["metrics"] == {"total_debit": "300.1", "total_credit": "300", "difference": "0.1", "side": "Debits exceed credits", "hints": []}
    assert f.source_proposal_id and f.payload["explanation_source"] == "template"


def test_footing_points_at_a_single_posting_equal_to_the_gap_and_at_transposition():
    spec = [("1000", "Cash", 100, 0), ("2000", "Payables", 0, 60), ("3000", "Capital", 0, 40), ("4000", "Revenue", 0, 45), ("5000", "Costs", 45, 0), ("6000", "Misc", 45, 0)]
    f = run(source(spec))[0].proposals[0]
    assert f.payload["metrics"]["difference"] == "45" and any("single posting" in h for h in f.payload["metrics"]["hints"])
    assert any("divisible by 9" in h for h in f.payload["metrics"]["hints"])
    assert {e["row"] for e in f.payload["evidence"]} >= {6, 7} and f.payload["evidence"][0]["cells"]  # lineage to source cells


def test_footing_respects_tenant_tolerance_and_can_be_switched_off():
    spec = [*GOOD[:-1], ("5000", "Cost of sales", 151, 0)]
    assert "tb_footing" in rule_ids(run(source(spec))[0])
    assert "tb_footing" not in rule_ids(run(source(spec, {"tb_footing": {"enabled": True, "params": {"tolerance": "1"}}}))[0])
    assert "tb_footing" not in rule_ids(run(source(spec, {"tb_footing": {"enabled": False, "params": {}}}))[0])
    assert "tb_footing" in rule_ids(run(source(spec, {"tb_footing": {"enabled": True, "params": {"tolerance": "garbage"}}}))[0])  # bad params -> default


def test_duplicates_missing_identifiers_both_sides_and_negatives():
    spec = [*GOOD, ("1000", "Cash again", 0, 0), ("", "Mystery", 0, 0), ("7000", "", 0, 0), ("7100", "Both", 5, 5), ("7200", "Neg", -5, 0)]
    ids = rule_ids(run(source(spec))[0])
    assert ids.count("tb_duplicate_accounts") == 1 and "tb_missing_identifiers" in ids and "tb_both_sides" in ids and "tb_negative_amounts" in ids


def test_codeless_charts_are_not_flagged_for_missing_codes():
    spec = [("", "Cash", 100, 0), ("", "Payables", 0, 100)]
    assert "tb_missing_identifiers" not in rule_ids(run(source(spec))[0])


def test_unusual_side_uses_account_ranges_but_respects_contra_accounts_and_equity():
    spec = [("1000", "Cash", 0, 100), ("1590", "Accumulated depreciation", 0, 40), ("2000", "Payables", 0, 60), ("3100", "Retained earnings", 80, 0),
            ("4000", "Revenue", 0, 200), ("5000", "Costs", 220, 0)]
    f = [p for p in run(source(spec))[0].proposals if p.rule_id == "tb_unusual_side"]
    assert len(f) == 1 and f[0].payload["metrics"]["count"] == 1  # only the credit-balance Cash; contra and retained earnings are fine
    assert f[0].confidence == 0.6  # honest: this is a heuristic
    nonstandard = [("A-1", "Cash", 0, 100), ("A-2", "Debtors", 100, 0)]
    assert "tb_unusual_side" not in rule_ids(run(source(nonstandard))[0])


def test_extraction_gaps_carry_over_from_the_extraction_stats():
    stats = {"unparsed_cells": 2, "totals_mismatch": True, "reported_total_debit": "999", "reported_total_credit": "999", "sum_debit": "300", "sum_credit": "300"}
    ids = rule_ids(run(source(GOOD, stats=stats))[0])
    assert ids.count("tb_extraction_gaps") == 2


def test_sparse_and_all_zero():
    assert "tb_sparse" in rule_ids(run(source([("1000", "Cash", 1, 0), ("2000", "Pay", 0, 1)]))[0])
    zero = run(source([(f"{1000 + i}", f"A{i}", 0, 0) for i in range(6)]))[0]
    assert any(p.title == "Every amount is zero" for p in zero.proposals)


def test_findings_are_ordered_errors_first():
    spec = [*GOOD[:-1], ("5000", "Cost of sales", 151, 0), ("5000", "dup", 0, 0)]
    sev = [p.severity for p in run(source(spec))[0].proposals]
    assert sev == sorted(sev, key={"error": 0, "warning": 1, "info": 2}.get)


def test_non_trial_balance_and_missing_sources_are_skipped_not_guessed():
    assert run(source(GOOD, schema="fixed_assets"))[0].meta.status == "skipped"
    assert run(None)[0].meta.status == "skipped"


# ---------------------------------------------------------------------------------------- explanations
FOOT = [*GOOD[:-1], ("5000", "Cost of sales", 175, 0)]  # difference 25


def test_no_model_is_called_unless_the_tenant_allows_it():
    res, gw = run(source(FOOT, ext=False), FakeGateway([Explanations(items=[Explanation(index=0, text="x")])]), allow=False)
    assert gw.calls == [] and res.meta.llm_calls == 0 and res.proposals[0].payload["explanation_source"] == "template"


def test_a_model_explanation_is_used_when_it_only_uses_figures_from_the_facts():
    text = "Debits are higher than credits by 25, so the balance sheet does not foot."
    res, gw = run(source(FOOT, ext=True), FakeGateway([Explanations(items=[Explanation(index=0, text=text)])]), allow=True)
    p = res.proposals[0]
    assert p.payload["explanation"] == text and p.payload["explanation_source"] == "llm" and res.meta.llm_calls == 1 and len(gw.calls) == 1
    assert "<facts>" in gw.calls[0]
    assert "tb_footing" in gw.calls[0] and "Cash" not in gw.calls[0]  # structured facts only, not raw cell text


def test_an_explanation_that_invents_a_figure_is_discarded():
    bad = "Debits exceed credits by 26 because of a missing posting of 1,000."
    res, _ = run(source(FOOT, ext=True), FakeGateway([Explanations(items=[Explanation(index=0, text=bad)])]), allow=True)
    assert res.proposals[0].payload["explanation_source"] == "template" and bad not in res.proposals[0].payload["explanation"]


def test_oversized_or_out_of_range_explanations_and_provider_failures_fall_back():
    for ans in (Explanations(items=[Explanation(index=0, text="a" * 600)]), Explanations(items=[Explanation(index=9, text="ok")])):
        res, _ = run(source(FOOT, ext=True), FakeGateway([ans]), allow=True)
        assert res.proposals[0].payload["explanation_source"] == "template"
    res, _ = run(source(FOOT, ext=True), NullGateway("down"), allow=True)
    assert res.proposals[0].payload["explanation_source"] == "template" and res.meta.llm_calls == 0


# ---------------------------------------------------------------------------------------- catalog contract
CATALOG = Path(__file__).resolve().parents[3] / "schemas" / "fixtures" / "validation_rules.json"


def test_rule_catalog_matches_the_golden_file_the_ui_is_checked_against():
    actual = full_catalog()  # validation and reconciliation rules together: what Settings lists
    if os.environ.get("UPDATE_FIXTURES"):
        CATALOG.write_text(json.dumps(actual, indent=2) + "\n")
    assert actual == json.loads(CATALOG.read_text())
    assert len({r["id"] for r in actual}) == len(actual)


def test_every_catalogued_rule_has_an_implementation():
    data = TBData("S", [Row(**{k: r[k] for k in ("position", "sheet", "source_row", "values", "cells", "issues")}) for r in rows(GOOD)], {}, {})
    _, ran = run_rules(data, {})
    assert ran == [r["id"] for r in rule_catalog()]


def test_display_figures_are_grouped_but_metrics_stay_exact():
    spec = [("1000", "Cash", 1250000, 0), ("2000", "Pay", 0, 1237550), ("3000", "Cap", 0, 1000)]
    f = run(source(spec))[0].proposals[0]
    assert f.title == "Debits and credits differ by 11,450" and "1,250,000" in f.detail
    assert f.payload["metrics"]["difference"] == "11450" and f.payload["metrics"]["total_debit"] == "1250000"


def test_suspense_balances_are_flagged_but_zero_balances_are_not():
    spec = [*GOOD[:-1], ("1999", "Suspense account", 25, 0), ("5000", "Cost of sales", 125, 0)]  # debits 300 = credits... keep footing: 100+50+25+125
    res = run(source(spec))[0]
    assert "tb_suspense_balances" in rule_ids(res)
    f = next(p for p in res.proposals if p.rule_id == "tb_suspense_balances")
    assert f.payload["metrics"]["total_abs"] == "25" and f.evidence
    clear = [*GOOD[:-1], ("1999", "Clearing account", 0, 0), ("5000", "Cost of sales", 150, 0)]
    assert "tb_suspense_balances" not in rule_ids(run(source(clear))[0])


def test_round_amounts_needs_enough_rows_and_a_high_share():
    many = [(f"{1000 + i}", f"Account {i}", 1000 * (i + 1), 0) for i in range(9)] + [("2000", "Payables", 0, 45000)]
    res = run(source(many))[0]
    assert "tb_round_amounts" in rule_ids(res)
    assert next(p for p in res.proposals if p.rule_id == "tb_round_amounts").payload["metrics"]["round"] == 10
    assert "tb_round_amounts" not in rule_ids(run(source(GOOD))[0])  # too few rows to judge
    irregular = [(f"{1000 + i}", f"Account {i}", 1000 * (i + 1) + 7, 0) for i in range(9)] + [("2000", "Payables", 0, 45063)]
    assert "tb_round_amounts" not in rule_ids(run(source(irregular))[0])


def test_intercompany_balances_listed_with_their_net_position():
    spec = [*GOOD[:-1], ("1500", "Intercompany receivable - Northwind GmbH", 30, 0), ("2500", "Intercompany payable - Northwind SAS", 0, 10), ("5000", "Cost of sales", 120, 0)]
    res = run(source(spec))[0]
    f = next(p for p in res.proposals if p.rule_id == "tb_intercompany_balances")
    assert f.severity == "info" and f.payload["metrics"] == {"count": 2, "net": "20"}
    assert "tb_intercompany_balances" not in rule_ids(run(source(GOOD))[0])


def test_new_rules_can_be_switched_off():
    spec = [*GOOD[:-1], ("1999", "Suspense", 25, 0), ("5000", "Cost of sales", 125, 0)]
    res = run(source(spec, settings={"tb_suspense_balances": {"enabled": False}}))[0]
    assert "tb_suspense_balances" not in rule_ids(res)
