"""Regression tests for the layouts real offices send: other languages, text-formatted numbers, notes under the table,
stacked tables and repeated headers. Uses the PLAIN-CODE path only (no model)."""
from __future__ import annotations

import json
from decimal import Decimal
from pathlib import Path

import pytest
from helpers import FakeFiles, context, make_xlsx, payload

from taxops_agents.agents.extraction import ExtractionAgent
from taxops_agents.agents.extraction.amounts import parse_amount
from taxops_agents.agents.extraction.mapping import norm
from taxops_agents.agents.validation.rules import Row, TBData, run_rules


def run(rows, sheet="TB"):
    files = FakeFiles(make_xlsx({sheet: rows}))
    ctx, _ = context(files, allow_llm=False)
    return ExtractionAgent().run(ctx, payload(files))


def findings(res):
    p = res.proposals[0]
    rows = [r for r in res.rows if r.proposal_index == 0]
    d, _ = run_rules(TBData(p.payload["sheet"], [Row(r.proposal_index + 1, r.sheet, r.source_row, r.values, r.cells, r.issues) for r in rows], p.payload["stats"], p.payload["metadata"]), {})
    return [x.rule_id for x in d]


def test_headers_in_spanish_french_german_and_portuguese_are_recognised_with_accents():
    for hdr in (["Cuenta", "Descripción", "Debe", "Haber"], ["Compte", "Libellé", "Débit", "Crédit"], ["Konto", "Kontenbezeichnung", "Soll", "Haben"], ["Conta", "Descrição", "Débito", "Crédito"]):
        res = run([hdr, ["1000", "Caja", 100, 0], ["2000", "Proveedores", 0, 100], ["3000", "Capital", 0, 0]])
        p = res.proposals[0]
        assert set(p.payload["columns"]) == {"account_code", "account_name", "debit", "credit"}, hdr
        assert p.payload["stats"]["sum_debit"] == "100" and p.payload["stats"]["sum_credit"] == "100"


def test_currency_tags_in_headers_and_prefixes_in_amounts():
    assert norm("Dr (SGD)") == "dr" and norm("Débito MXN") == "debito" and norm("Descripción") == "descripcion"
    for text, want in (("S$1,200.00", "1200.00"), ("R$ 1.234,56", "1234.56"), ("MX$99.5", "99.5"), ("€ 1.250,00", "1250.00"), ("(US$ 3,000.00)", "-3000.00")):
        d, ok = parse_amount(text)
        assert ok and d == Decimal(want), text
    res = run([["Acct", "Account Description", "Dr (SGD)", "Cr (SGD)"], ["1000", "Cash", "S$1,200.00", "-"], ["2000", "Payable", "-", "S$1,200.00"]])
    assert res.proposals[0].payload["stats"]["sum_debit"] == "1200"


def test_european_and_french_text_numbers_are_read_exactly():
    res = run([["Compte", "Libellé", "Débit", "Crédit"], ["1000", "Trésorerie", "1 234 567,89", ""], ["2000", "Fournisseurs", "", "1 234 567,89"], ["", "Total", "1 234 567,89", "1 234 567,89"]])
    st = res.proposals[0].payload["stats"]
    assert st["sum_debit"] == "1234567.89" and st["sum_credit"] == "1234567.89" and "totals_mismatch" not in st


def test_notes_and_sign_off_lines_under_the_table_are_not_accounts_but_zero_accounts_are():
    rows = [["Account", "Description", "Debit", "Credit"], ["1000", "Cash", 100, 0], ["2000", "Payable", 0, 100], ["3000", "Dormant account", None, None],
            [], ["Prepared by A. Singh"], ["Note: bonus accrual not yet booked", "see tab 4"]]
    res = run(rows)
    codes = [r.values["account_code"] for r in res.rows]
    assert codes == ["1000", "2000", "3000"]           # the zero-balance account stays; the notes do not
    assert any("skipped" in n for n in res.proposals[0].payload["notes"])


def test_a_header_that_repeats_at_a_page_break_is_not_a_new_table():
    hdr = ["Account", "Description", "Debit", "Credit"]
    res = run([hdr, ["1000", "Cash", 100, 0], hdr, ["2000", "Payable", 0, 100]])
    assert len(res.proposals) == 1 and res.proposals[0].payload["stats"]["row_count"] == 2


def test_two_entities_stacked_on_one_sheet_become_two_results_with_true_row_numbers():
    rows = [["Entity A"], ["Conta", "Descrição", "Débito", "Crédito"], ["1000", "Caixa", 100, 0], ["2000", "Fornecedores", 0, 100], ["", "Total", 100, 100], [],
            ["Entity B"], ["Cuenta", "Descripción", "Debe", "Haber"], ["1000", "Caja", 50, 0], ["2000", "Proveedores", 0, 50], ["", "Total", 50, 50]]
    res = run(rows, sheet="Group")
    assert [p.payload["sheet"] for p in res.proposals] == ["Group", "Group (table 2)"]
    assert [p.payload["stats"]["sum_debit"] for p in res.proposals] == ["100", "50"]    # not merged
    second = [r for r in res.rows if r.proposal_index == 1]
    assert [r.source_row for r in second] == [9, 10] and all(r.sheet == "Group" for r in second)  # lineage points at the real sheet rows
    assert any("holds 2 tables" in n for n in res.proposals[0].payload["notes"])


def test_an_unmapped_name_column_does_not_make_every_account_look_unnamed():
    res = run([["Nominal code", "Memo", "Debit", "Credit"], ["1000", "x", 100, 0], ["2000", "y", 0, 100], ["3000", "z", 5, 5]])
    # whatever was mapped, the rule must not flag every row for a column that is absent
    p = res.proposals[0]
    if "account_name" not in p.payload["columns"]:
        assert "tb_missing_identifiers" not in findings(res)


def test_contra_and_equity_accounts_are_recognised_in_other_languages():
    spec = [("1000", "Efectivo", 1100, 0), ("1650", "Depreciación acumulada", 0, 100), ("2000", "Proveedores", 0, 500), ("3100", "Utilidades acumuladas", 0, 500)]
    res = run([["Cuenta", "Descripción", "Debe", "Haber"], *[list(s) for s in spec]])
    assert "tb_unusual_side" not in findings(res)
    for name in ("Amortissements cumulés", "Kumulierte Abschreibung"):
        res = run([["Account", "Description", "Debit", "Credit"], ["1000", "Cash", 100, 0], ["1650", name, 0, 100]])
        assert "tb_unusual_side" not in findings(res), name


SAMPLES = Path(__file__).resolve().parents[3] / "samples" / "messy"


@pytest.mark.skipif(not (SAMPLES / "truth.json").exists(), reason="messy samples not generated (python3 scripts/make-messy-samples.py)")
def test_every_messy_sample_file_is_extracted_exactly():
    truth = json.loads((SAMPLES / "truth.json").read_text())
    for name, t in truth.items():
        files = FakeFiles((SAMPLES / name).read_bytes(), name=name)
        ctx, _ = context(files, allow_llm=False)
        res = ExtractionAgent().run(ctx, payload(files))
        want = {a["code"]: Decimal(a["debit"]) - Decimal(a["credit"]) for a in t["accounts"]}
        best = max(range(len(res.proposals)), key=lambda i: sum(1 for r in res.rows if r.proposal_index == i and want.get(r.values["account_code"]) == Decimal(r.values["debit"]) - Decimal(r.values["credit"])))
        got = {r.values["account_code"]: Decimal(r.values["debit"]) - Decimal(r.values["credit"]) for r in res.rows if r.proposal_index == best}
        assert got == want, name


def test_currency_is_found_from_titles_headers_and_symbols_and_never_guessed_from_a_bare_dollar_sign():
    def meta(rows):
        return run(rows).proposals[0].payload["metadata"]
    hdr = ["Account", "Description", "Debit", "Credit"]
    assert meta([["Northwind – TB", "", "Moneda: MXN"], hdr, ["1000", "Caja", 1, 0], ["2000", "Prov", 0, 1]])["currency"] == "MXN"
    m = meta([["Acct", "Account Description", "Dr (SGD)", "Cr (SGD)"], ["1000", "Cash", 1, 0], ["2000", "Pay", 0, 1]])
    assert m["currency"] == "SGD" and m["currency_source"] == "column header"
    m = meta([hdr, ["1000", "Cash", "R$ 1,00", ""], ["2000", "Pay", "", "R$ 1,00"]])
    assert m["currency"] == "BRL" and m["currency_source"] == "amount symbols"
    assert "currency" not in meta([hdr, ["1000", "Cash", "$1.00", ""], ["2000", "Pay", "", "$1.00"]])      # "$" could be many currencies
    m = meta([["Group reporting in EUR, local in USD"], hdr, ["1000", "Cash", 1, 0], ["2000", "Pay", 0, 1]])
    assert "currency" not in m and "EUR, USD" in m["currency_note"]                                        # conflicting: not guessed


def test_a_stacked_second_table_gets_its_own_currency():
    rows = [["Entity A: Brasil – BRL"], ["Conta", "Descrição", "Débito", "Crédito"], ["1000", "Caixa", 100, 0], ["2000", "Forn", 0, 100], ["", "Total", 100, 100], [],
            ["Entity B: Chile – CLP"], ["Cuenta", "Descripción", "Debe", "Haber"], ["1000", "Caja", 50, 0], ["2000", "Prov", 0, 50]]
    res = run(rows, sheet="Group")
    assert [p.payload["metadata"].get("currency") for p in res.proposals] == ["BRL", "CLP"]
