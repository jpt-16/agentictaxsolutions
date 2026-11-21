"""Deterministic validation rules for trial balances.

Every rule is plain arithmetic/string logic over exact decimals: no model decides whether something is wrong. A model may
later be asked only to EXPLAIN a finding in words (see agent.py), never to find or size one.
"""
from __future__ import annotations

import re
from collections import defaultdict
from dataclasses import dataclass, field
from decimal import Decimal, InvalidOperation
from typing import Any

from ..extraction.amounts import fmt


@dataclass(frozen=True)
class RuleSpec:
    id: str
    name: str
    description: str
    severity: str  # default severity: info | warning | error
    confidence: float
    params: dict[str, str] = field(default_factory=dict)  # defaults; decimal strings


RULES: tuple[RuleSpec, ...] = (
    RuleSpec("tb_footing", "Debits equal credits", "Total debits must equal total credits (within a tolerance).", "error", 1.0, {"tolerance": "0"}),
    RuleSpec("tb_duplicate_accounts", "No duplicate accounts", "An account code should appear once in a trial balance.", "warning", 0.95),
    RuleSpec("tb_missing_identifiers", "Accounts are identified", "Every row needs both an account code and an account name.", "warning", 0.95),
    RuleSpec("tb_both_sides", "One side per account", "An account line should not carry both a debit and a credit.", "warning", 0.95),
    RuleSpec("tb_negative_amounts", "No negative debit/credit amounts", "Debit and credit columns should hold positive amounts.", "warning", 0.95),
    RuleSpec("tb_unusual_side", "Balances sit on their usual side", "Flags accounts whose balance is on the opposite side to what their account number range suggests (assumes standard 1xxx-8xxx numbering).", "warning", 0.6, {"min_amount": "0"}),
    RuleSpec("tb_extraction_gaps", "Extraction is complete", "Flags unreadable amounts and a sheet total row that disagrees with the rows read.", "warning", 0.9),
    RuleSpec("tb_sparse", "Plausible size", "Flags very small or all-zero trial balances.", "info", 0.8, {"min_rows": "5"}),
    RuleSpec("tb_suspense_balances", "No balances left in suspense", "Flags non-zero balances in suspense, clearing or unreconciled accounts, which should be cleared before the numbers are relied on.", "warning", 0.85, {"min_amount": "0"}),
    RuleSpec("tb_round_amounts", "Few round-number balances", "Flags trial balances where many balances are exact multiples of 1,000, which can indicate estimates or manual plugs.", "info", 0.55, {"min_rows": "10", "share_percent": "60", "multiple": "1000"}),
    RuleSpec("tb_intercompany_balances", "Intercompany balances to confirm", "Lists intercompany accounts with a balance so they can be agreed with the counterparty entity, and shows their net position.", "info", 0.8, {"min_amount": "0"}),
)
RULE_BY_ID = {r.id: r for r in RULES}
SEVERITY_ORDER = {"error": 0, "warning": 1, "info": 2}


@dataclass
class Row:
    position: int
    sheet: str
    source_row: int
    values: dict[str, Any]
    cells: dict[str, str]
    issues: list[str]

    @property
    def code(self) -> str:
        return str(self.values.get("account_code", "")).strip()

    @property
    def name(self) -> str:
        return str(self.values.get("account_name", "")).strip()

    def amount(self, key: str) -> Decimal:
        try:
            return Decimal(str(self.values.get(key, "0") or "0"))
        except InvalidOperation:
            return Decimal(0)


@dataclass
class Draft:
    rule_id: str
    severity: str
    title: str
    summary: str
    suggestion: str
    dedupe: str
    metrics: dict[str, Any] = field(default_factory=dict)
    evidence: list[dict[str, Any]] = field(default_factory=list)


@dataclass
class TBData:
    sheet: str
    rows: list[Row]
    stats: dict[str, Any]
    metadata: dict[str, str]


def _ev(r: Row, note: str, keys: tuple[str, ...] = ("account_code", "debit", "credit")) -> dict[str, Any]:
    return {"row": r.source_row, "sheet": r.sheet, "cells": [r.cells[k] for k in keys if k in r.cells], "note": note}


def grouped(d: Decimal) -> str:
    """Display form with thousands separators (titles and summaries only; metrics stay exact and ungrouped)."""
    text = fmt(d)
    whole, _, frac = text.lstrip("-").partition(".")
    out = f"{int(whole):,}" + (f".{frac}" if frac else "")
    return "-" + out if text.startswith("-") else out


def _dec(params: dict[str, Any], key: str, default: str) -> Decimal:
    try:
        d = Decimal(str(params.get(key, default)))
        return d if d.is_finite() and d >= 0 else Decimal(default)
    except InvalidOperation:
        return Decimal(default)


# ---------------------------------------------------------------------------------------------------- rules
def tb_footing(d: TBData, p: dict[str, Any]) -> list[Draft]:
    debit = sum((r.amount("debit") for r in d.rows), Decimal(0))
    credit = sum((r.amount("credit") for r in d.rows), Decimal(0))
    diff = debit - credit
    if abs(diff) <= _dec(p, "tolerance", "0"):
        return []
    side = "Debits exceed credits" if diff > 0 else "Credits exceed debits"
    hints: list[str] = []
    ev: list[dict[str, Any]] = []
    target = abs(diff)
    for r in d.rows:
        for key in ("debit", "credit"):
            if r.amount(key) == target and len(ev) < 3:
                ev.append(_ev(r, f"This {key} equals the difference; it may be mis-keyed or posted to one side only."))
    if ev:
        hints.append("A single posting equals the difference.")
    if target == target.to_integral_value() and int(target) % 9 == 0:
        hints.append("The difference is divisible by 9, which can indicate transposed digits.")
    return [Draft(
        "tb_footing", RULE_BY_ID["tb_footing"].severity, f"Debits and credits differ by {grouped(target)}",
        f"{side}: total debits {grouped(debit)}, total credits {grouped(credit)}, difference {grouped(target)}.",
        "Check for a missing or one-sided posting, a mis-keyed amount, or an account left out of the export. " + " ".join(hints),
        d.sheet, {"total_debit": fmt(debit), "total_credit": fmt(credit), "difference": fmt(target), "side": side, "hints": hints}, ev,
    )]


def tb_duplicate_accounts(d: TBData, p: dict[str, Any]) -> list[Draft]:
    groups: dict[str, list[Row]] = defaultdict(list)
    for r in d.rows:
        if r.code:
            groups[r.code].append(r)
    out = []
    for code, rows in groups.items():
        if len(rows) > 1:
            out.append(Draft("tb_duplicate_accounts", RULE_BY_ID["tb_duplicate_accounts"].severity, f"Account {code} appears {len(rows)} times",
                             f"Account {code} is listed on rows {', '.join(str(r.source_row) for r in rows)}.",
                             "Confirm whether these are separate sub-ledgers or an accidental duplicate before totals are relied on.",
                             f"{d.sheet}|{code}", {"account": code, "count": len(rows)}, [_ev(r, "Duplicate account code") for r in rows[:6]]))
    return out


def tb_missing_identifiers(d: TBData, p: dict[str, Any]) -> list[Draft]:
    has_codes, has_names = any(r.code for r in d.rows), any(r.name for r in d.rows)
    if not (has_codes or has_names):
        return []
    # A column that was never mapped (or never filled) is a format choice, not an error on every row; only gaps in a column that is used.
    bad = [r for r in d.rows if (has_codes and not r.code) or (has_names and not r.name)]
    if not bad:
        return []
    return [Draft("tb_missing_identifiers", RULE_BY_ID["tb_missing_identifiers"].severity, f"{len(bad)} account(s) missing a code or name",
                  f"Rows {', '.join(str(r.source_row) for r in bad[:10])}{'…' if len(bad) > 10 else ''} lack an account code or name.",
                  "Fill in the missing identifiers so every balance can be mapped to the chart of accounts.", d.sheet, {"count": len(bad)},
                  [_ev(r, "Missing " + ("code" if has_codes and not r.code else "name"), ("account_code", "account_name")) for r in bad[:10]])]


def tb_both_sides(d: TBData, p: dict[str, Any]) -> list[Draft]:
    bad = [r for r in d.rows if r.amount("debit") != 0 and r.amount("credit") != 0]
    if not bad:
        return []
    return [Draft("tb_both_sides", RULE_BY_ID["tb_both_sides"].severity, f"{len(bad)} account(s) have both a debit and a credit",
                  f"Rows {', '.join(str(r.source_row) for r in bad[:10])} carry amounts on both sides.",
                  "Net each account to a single balance, or confirm the export does not already net them.", d.sheet, {"count": len(bad)},
                  [_ev(r, "Debit and credit both populated") for r in bad[:10]])]


def tb_negative_amounts(d: TBData, p: dict[str, Any]) -> list[Draft]:
    bad = [r for r in d.rows if r.amount("debit") < 0 or r.amount("credit") < 0]
    if not bad:
        return []
    return [Draft("tb_negative_amounts", RULE_BY_ID["tb_negative_amounts"].severity, f"{len(bad)} negative amount(s) in debit/credit columns",
                  f"Rows {', '.join(str(r.source_row) for r in bad[:10])} hold negative debits or credits.",
                  "Negative amounts usually mean a reversal or a sign error. Confirm and restate on the correct side.", d.sheet, {"count": len(bad)},
                  [_ev(r, "Negative amount") for r in bad[:10]])]


# Account-name stems (accent-free, so they match with or without accents) for accounts that legitimately sit on the "other" side.
_CONTRA = re.compile(
    r"accumulated|allowance|provision|depreciation|amorti[sz]ation|reserve|contra|discount|"
    r"acumulad|depreciaci|amortizaci|estimaci|reserva|"          # Spanish / Portuguese
    r"abschreib|wertberichtig|r.ckstell|kumuliert|"               # German
    r"amortissement|cumul|d.pr.ciation",                          # French
    re.IGNORECASE,
)
_EITHER_EQUITY = re.compile(
    r"retained|deficit|drawing|dividend|treasury|reserve|translation|oci|"
    r"utilidad|resultado|acumulad|reserva|"                       # Spanish / Portuguese
    r"vortrag|gewinn|verlust|r.cklage|"                           # German
    r"report . nouveau|r.sultat|r.serve",                         # French
    re.IGNORECASE,
)


def tb_unusual_side(d: TBData, p: dict[str, Any]) -> list[Draft]:
    coded = [r for r in d.rows if re.fullmatch(r"[1-8]\d{2,5}", r.code)]
    if not d.rows or len(coded) / len(d.rows) < 0.7:
        return []  # not a recognisable standard numbering: do not guess
    floor = _dec(p, "min_amount", "0")
    bad: list[tuple[Row, str]] = []
    for r in coded:
        net = r.amount("debit") - r.amount("credit")
        if net == 0 or abs(net) < floor:
            continue
        first = r.code[0]
        expect = {"1": "debit", "2": "credit", "3": "credit", "4": "credit", "5": "debit", "6": "debit", "7": "debit", "8": "debit"}[first]
        if first == "1" and _CONTRA.search(r.name):
            expect = "credit"
        if first == "3" and _EITHER_EQUITY.search(r.name):
            continue
        if first == "8":
            continue  # tax lines can legitimately be credits
        actual = "debit" if net > 0 else "credit"
        if actual != expect:
            bad.append((r, expect))
    if not bad:
        return []
    return [Draft("tb_unusual_side", RULE_BY_ID["tb_unusual_side"].severity, f"{len(bad)} balance(s) on an unusual side",
                  "These balances sit opposite to the usual side for their account range: " + "; ".join(f"{r.code} {r.name} (usually {e})" for r, e in bad[:5]) + ("…" if len(bad) > 5 else "") + ".",
                  "Often a sign error or a contra account without a recognisable name. This check assumes standard 1xxx-8xxx numbering and can be a false alarm.",
                  d.sheet, {"count": len(bad)}, [_ev(r, f"Balance is on the {'credit' if r.amount('credit') > r.amount('debit') else 'debit'} side; usually {e}") for r, e in bad[:10]])]


def tb_extraction_gaps(d: TBData, p: dict[str, Any]) -> list[Draft]:
    out = []
    n = int(d.stats.get("unparsed_cells", 0))
    if n:
        out.append(Draft("tb_extraction_gaps", RULE_BY_ID["tb_extraction_gaps"].severity, f"{n} amount(s) could not be read",
                         f"{n} cell(s) in the amount columns were not valid numbers and were left out of the totals.",
                         "Correct the cells in the source file and resubmit, or confirm they are intentionally blank.", f"{d.sheet}|unparsed", {"count": n}, []))
    if d.stats.get("totals_mismatch"):
        out.append(Draft("tb_extraction_gaps", RULE_BY_ID["tb_extraction_gaps"].severity, "The sheet's own total row disagrees with the rows read",
                         f"The file reports totals of {d.stats.get('reported_total_debit')} / {d.stats.get('reported_total_credit')} but the rows read sum to {d.stats.get('sum_debit')} / {d.stats.get('sum_credit')}.",
                         "Some rows may have been missed or the total row is stale. Compare against the source file.", f"{d.sheet}|totals",
                         {"reported_debit": d.stats.get("reported_total_debit"), "reported_credit": d.stats.get("reported_total_credit"), "read_debit": d.stats.get("sum_debit"), "read_credit": d.stats.get("sum_credit")}, []))
    return out


def tb_sparse(d: TBData, p: dict[str, Any]) -> list[Draft]:
    out = []
    if d.rows and all(r.amount("debit") == 0 and r.amount("credit") == 0 for r in d.rows):
        out.append(Draft("tb_sparse", "warning", "Every amount is zero", "All accounts in this trial balance have zero debit and credit.",
                         "An empty export is likely. Confirm the right period and entity were exported.", f"{d.sheet}|zero", {"rows": len(d.rows)}, []))
    min_rows = int(_dec(p, "min_rows", "5"))
    if len(d.rows) < min_rows:
        out.append(Draft("tb_sparse", RULE_BY_ID["tb_sparse"].severity, f"Only {len(d.rows)} account(s)", f"This trial balance has {len(d.rows)} account line(s), fewer than the expected {min_rows}.",
                         "Check the export is complete and not filtered to a subset of accounts.", f"{d.sheet}|few", {"rows": len(d.rows), "min_rows": min_rows}, []))
    return out


_SUSPENSE = re.compile(r"suspense|clearing|unreconciled|unallocated|unapplied|to be classified|tbc\b", re.IGNORECASE)
_INTERCO = re.compile(r"inter[\s-]?company|intra[\s-]?group|due (?:to|from) (?:affiliate|related|group)|affiliate receivable|affiliate payable", re.IGNORECASE)


def tb_suspense_balances(d: TBData, p: dict[str, Any]) -> list[Draft]:
    floor = _dec(p, "min_amount", "0")
    bad = [r for r in d.rows if _SUSPENSE.search(r.name) and abs(r.amount("debit") - r.amount("credit")) > floor]
    if not bad:
        return []
    total = sum((abs(r.amount("debit") - r.amount("credit")) for r in bad), Decimal(0))
    return [Draft("tb_suspense_balances", RULE_BY_ID["tb_suspense_balances"].severity, f"{len(bad)} suspense or clearing account(s) hold a balance",
                  "Balances remain in: " + "; ".join(f"{r.code} {r.name}".strip() for r in bad[:5]) + ("…" if len(bad) > 5 else "") + f". Combined absolute balance {grouped(total)}.",
                  "Clear these to the correct accounts, or document why they remain open at period end.", d.sheet,
                  {"count": len(bad), "total_abs": fmt(total)}, [_ev(r, "Balance held in a suspense/clearing account") for r in bad[:10]])]


def tb_round_amounts(d: TBData, p: dict[str, Any]) -> list[Draft]:
    min_rows = int(_dec(p, "min_rows", "10"))
    mult = _dec(p, "multiple", "1000")
    share = _dec(p, "share_percent", "60")
    if mult <= 0:
        return []
    amounts = [(r, a) for r in d.rows for a in (r.amount("debit"), r.amount("credit")) if a != 0]
    if len(amounts) < min_rows:
        return []
    round_n = sum(1 for _, a in amounts if a % mult == 0)
    pct = Decimal(round_n) * 100 / Decimal(len(amounts))
    if pct < share:
        return []
    return [Draft("tb_round_amounts", RULE_BY_ID["tb_round_amounts"].severity, f"{round_n} of {len(amounts)} balances are exact multiples of {grouped(mult)}",
                  f"{round_n} of {len(amounts)} non-zero balances ({pct.quantize(Decimal(1))}%) are exact multiples of {grouped(mult)}.",
                  "Real ledger balances are rarely this round. Confirm the figures are not estimates, rounded exports or manual plugs.", d.sheet,
                  {"round": round_n, "total": len(amounts), "multiple": fmt(mult), "percent": str(pct.quantize(Decimal(1)))}, [])]


def tb_intercompany_balances(d: TBData, p: dict[str, Any]) -> list[Draft]:
    floor = _dec(p, "min_amount", "0")
    rows = [r for r in d.rows if _INTERCO.search(r.name) and abs(r.amount("debit") - r.amount("credit")) > floor]
    if not rows:
        return []
    net = sum((r.amount("debit") - r.amount("credit") for r in rows), Decimal(0))
    side = "net debit" if net > 0 else "net credit" if net < 0 else "nets to zero"
    return [Draft("tb_intercompany_balances", RULE_BY_ID["tb_intercompany_balances"].severity, f"{len(rows)} intercompany balance(s) to confirm",
                  f"Intercompany accounts hold balances ({side}{'' if net == 0 else ' ' + grouped(abs(net))}): " + "; ".join(f"{r.code} {r.name}".strip() for r in rows[:5]) + ("…" if len(rows) > 5 else "") + ".",
                  "Agree each balance with the counterparty entity. A single entity's intercompany accounts need not net to zero; the group's should.", d.sheet,
                  {"count": len(rows), "net": fmt(net)}, [_ev(r, "Intercompany balance") for r in rows[:10]])]


CHECKS = {
    "tb_footing": tb_footing, "tb_duplicate_accounts": tb_duplicate_accounts, "tb_missing_identifiers": tb_missing_identifiers,
    "tb_both_sides": tb_both_sides, "tb_negative_amounts": tb_negative_amounts, "tb_unusual_side": tb_unusual_side,
    "tb_extraction_gaps": tb_extraction_gaps, "tb_sparse": tb_sparse,
    "tb_suspense_balances": tb_suspense_balances, "tb_round_amounts": tb_round_amounts, "tb_intercompany_balances": tb_intercompany_balances,
}


def run_rules(data: TBData, settings: dict[str, dict[str, Any]]) -> tuple[list[Draft], list[str]]:
    """Runs every ENABLED rule. Returns drafts (errors first) and the ids that ran."""
    drafts: list[Draft] = []
    ran: list[str] = []
    for spec in RULES:
        st = settings.get(spec.id, {})
        if not st.get("enabled", True):
            continue
        ran.append(spec.id)
        drafts.extend(CHECKS[spec.id](data, {**spec.params, **(st.get("params") or {})}))
    drafts.sort(key=lambda x: (SEVERITY_ORDER[x.severity], x.rule_id, x.dedupe))
    return drafts, ran
