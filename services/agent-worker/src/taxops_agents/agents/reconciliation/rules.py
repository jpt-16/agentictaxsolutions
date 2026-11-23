"""Deterministic reconciliation of a balance confirmation (a document) against accepted trial balances in the same request.

Plain arithmetic and string matching on exact decimals; no model decides whether two figures agree. What it can and cannot know is
stated in every finding. A trial balance may carry the legal entity a person confirmed it belongs to. With it, two entities' books can be
compared with each other (what A says it is owed by B against what B says it owes A). Without it, the direction check carries the
assumption explicitly and is a "please check", not a verdict.
"""
from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass, field
from decimal import Decimal
from typing import Any

from ...contract import RelatedProposal
from ..extraction.amounts import fmt, parse_amount
from ..validation.rules import Draft, Row, RuleSpec, grouped

RULES: tuple[RuleSpec, ...] = (
    RuleSpec("rc_amount_unmatched", "Confirmed amount agrees with the books",
             "A balance confirmation states an amount that no account in the request's accepted trial balances carries (within a tolerance).", "warning", 0.8, {"tolerance": "0"}),
    RuleSpec("rc_direction", "Direction of a confirmed balance",
             "The confirmation and the matching account both describe the amount as a payable (or both as a receivable). The two parties to a balance should record opposite sides.", "warning", 0.55),
    RuleSpec("rc_currency", "Currencies are comparable",
             "The confirmation and a trial balance are in different currencies, so their amounts were not compared.", "info", 0.85),
    RuleSpec("rc_mirror", "Entities agree on what they owe each other",
             "Two entities' trial balances both carry an intercompany balance with each other. What one is owed must equal what the other owes, on opposite sides.", "warning", 0.65, {"tolerance": "0"}),
    RuleSpec("rc_agreement", "Agreements are recorded",
             "Records when a confirmation agrees with an account, so a reviewer can see what was checked and not only what failed.", "info", 0.9),
)
RULE_BY_ID = {r.id: r for r in RULES}

_SYMBOLS = (("US$", "USD"), ("MX$", "MXN"), ("CA$", "CAD"), ("C$", "CAD"), ("AU$", "AUD"), ("A$", "AUD"), ("S$", "SGD"), ("R$", "BRL"), ("€", "EUR"), ("£", "GBP"))
_ISO = re.compile(r"\b(USD|EUR|GBP|CAD|AUD|NZD|SGD|JPY|BRL|CHF|CNY|INR|MXN|SEK|NOK|DKK|PLN|PEN|COP|CLP|ARS|ZAR|HKD|AED|TRY|CZK|HUF|RON)\b")
_PAYABLE = re.compile(r"payable|owed to|\bowes\b|due to\b|amount due|accounts payable|creditor|verbindlichkeit|por pagar|a pagar|fournisseur|dette", re.IGNORECASE)
_RECEIVABLE = re.compile(r"receivable|owed by|due from|forderung|por cobrar|a cobrar|cr.ance|cr.dito a favor", re.IGNORECASE)
_INTERCO = re.compile(r"inter[\s-]?company|intra[\s-]?group|affiliate|related part", re.IGNORECASE)


def currency_of(text: str) -> str | None:
    """ISO code or an unambiguous symbol. A bare "$" or "¥" could be several currencies, so it yields None."""
    m = _ISO.search(text)
    if m:
        return m.group(1)
    return next((code for sym, code in _SYMBOLS if sym in text), None)


def side_of(text: str) -> str | None:
    p, r = bool(_PAYABLE.search(text)), bool(_RECEIVABLE.search(text))
    return "payable" if p and not r else "receivable" if r and not p else None


def opposite(side: str) -> str:
    return "receivable" if side == "payable" else "payable"


@dataclass
class Amount:
    text: str
    value: Decimal
    currency: str | None
    context: str  # the words around the amount in the document, used only for the direction check


@dataclass
class Doc:
    id: str
    file_name: str
    item_title: str
    excerpt: str
    amounts: list[Amount]


@dataclass
class TB:
    id: str
    file_name: str
    sheet: str
    currency: str | None
    rows: list[Row]
    complete: bool = True  # False when only part of the trial balance was read, so absence of an amount proves nothing
    entity_id: str | None = None
    entity_name: str | None = None


@dataclass
class Data:
    docs: list[Doc]
    tbs: list[TB]
    settings: dict[str, dict[str, Any]] = field(default_factory=dict)
    entities: list[dict[str, Any]] = field(default_factory=list)


def load(proposals: list[RelatedProposal], entities: list[dict[str, Any]] | None = None) -> Data:
    docs: list[Doc] = []
    tbs: list[TB] = []
    for p in proposals:
        pl = p.payload
        if p.schema_key == "trial_balance":
            tbs.append(TB(str(p.id), p.file_name, str(pl.get("sheet", "")), (pl.get("metadata") or {}).get("currency"),
                          [Row(r["position"], r["sheet"], r["source_row"], r["values"], r["cells"], list(r.get("issues") or [])) for r in p.rows],
                          p.row_total is None or p.row_total <= len(p.rows),
                          str(p.entity["id"]) if p.entity else None, str(p.entity["name"]) if p.entity else None))
        elif p.schema_key == "supporting_document" and pl.get("document_type") == "Balance confirmation":
            excerpt = str(pl.get("excerpt", ""))
            amounts: list[Amount] = []
            for a in (pl.get("facts") or {}).get("amounts", []):
                value, ok = parse_amount(a)
                if not ok or value is None or value == 0:
                    continue
                i = excerpt.find(a)
                ctx = excerpt[max(0, i - 120): i + len(a) + 120] if i >= 0 else ""
                amounts.append(Amount(a, abs(value), currency_of(a), ctx))
            if amounts:
                docs.append(Doc(str(p.id), p.file_name, p.item_title, excerpt, amounts))
    return Data(docs, tbs, entities=list(entities or []))


def _tol(settings: dict[str, dict[str, Any]], rule: str) -> Decimal:
    try:
        v = Decimal(str((settings.get(rule, {}).get("params") or {}).get("tolerance", RULE_BY_ID[rule].params["tolerance"])))
        return v if v.is_finite() and v >= 0 else Decimal(0)
    except Exception:  # noqa: BLE001 - a bad stored setting falls back to exact matching
        return Decimal(0)


def _net(r: Row) -> Decimal:
    return r.amount("debit") - r.amount("credit")


def _counterparty(name: str) -> str:
    """The entity named after a dash in an account name, e.g. 'Intercompany payable - Northwind France SAS' -> 'Northwind France SAS'."""
    parts = re.split(r"\s[-–—]\s", name, maxsplit=1)
    return parts[1].strip() if len(parts) == 2 else ""


def _ev(r: Row, note: str) -> dict[str, Any]:
    return {"row": r.source_row, "sheet": r.sheet, "cells": [r.cells[k] for k in ("account_code", "debit", "credit") if k in r.cells], "note": note}


_LEGAL_FORMS = {"gmbh", "ag", "sas", "sarl", "sa", "ltd", "limited", "llc", "inc", "corp", "corporation", "plc", "bv", "nv", "pty", "pte", "kk", "co", "company",
                "srl", "spa", "oy", "ab", "as", "ltda", "ulc", "lp", "llp", "de", "cv", "holdings", "group"}


def _norm(s: str) -> str:
    s = unicodedata.normalize("NFKD", s)
    s = "".join(c for c in s if not unicodedata.combining(c)).lower()
    return re.sub(r"[^a-z0-9]+", " ", s).strip()


def _core(name: str) -> list[str]:
    allt = [t for t in _norm(name).split(" ") if t]
    core = [t for t in allt if t not in _LEGAL_FORMS]
    return core or allt


def names_entity(text: str, name: str, all_names: list[str]) -> bool:
    """True when an account title names the entity. A brand shared by every entity does not identify one, so an entity whose name is
    only the shared brand must be named with its legal form ("Northwind GmbH"). Mirrors the matching used by the app."""
    hay = f" {_norm(text)} "
    df: dict[str, int] = {}
    for n in all_names:
        for t in set(_core(n)):
            df[t] = df.get(t, 0) + 1
    full = _core(name)
    distinct = [t for t in full if df.get(t, 0) < len(all_names)] if len(all_names) > 1 else full
    phrase = lambda toks: bool(toks) and f" {' '.join(toks)} " in hay
    if not distinct:
        return phrase([t for t in _norm(name).split(" ") if t])
    return phrase(full) or phrase(distinct)


def _side_word(net: Decimal) -> str:
    return "receivable" if net > 0 else "payable"


def mirror(data: Data) -> list[Draft]:
    """Compares each pair of entities' trial balances: what A says it is owed by B must equal what B says it owes A."""
    out: list[Draft] = []
    enabled = data.settings.get("rc_mirror", {}).get("enabled", True)
    tol = _tol(data.settings, "rc_mirror")
    names = [str(e["name"]) for e in data.entities] or [t.entity_name for t in data.tbs if t.entity_name]  # type: ignore[misc]
    named = [t for t in data.tbs if t.entity_id and t.entity_name]
    seen: set[tuple[str, str]] = set()
    for a in named:
        for b in named:
            if a.entity_id == b.entity_id or (b.entity_id, a.entity_id) in seen:  # type: ignore[operator]
                continue
            seen.add((a.entity_id, b.entity_id))  # type: ignore[arg-type]
            rows_a = [r for r in a.rows if names_entity(r.name, b.entity_name or "", names)]
            rows_b = [r for r in b.rows if names_entity(r.name, a.entity_name or "", names)]
            if not rows_a and not rows_b:
                continue
            pair = f"{a.entity_name} and {b.entity_name}"
            if a.currency and b.currency and a.currency != b.currency:
                if data.settings.get("rc_currency", {}).get("enabled", True):
                    out.append(Draft("rc_currency", RULE_BY_ID["rc_currency"].severity, f"{pair} are in different currencies",
                                     f"{a.entity_name}'s trial balance is in {a.currency} and {b.entity_name}'s is in {b.currency}, so what they owe each other was not compared.",
                                     "Compare them after converting at the agreed rate.", f"mirror|{a.entity_id}|{b.entity_id}|ccy",
                                     {"entities": [a.entity_name, b.entity_name], "currencies": [a.currency, b.currency]}, []))
                continue
            net_a = sum((_net(r) for r in rows_a), Decimal(0))
            net_b = sum((_net(r) for r in rows_b), Decimal(0))
            ev = [_ev(r, f"{a.entity_name}: balance with {b.entity_name}") for r in rows_a[:3]] + [_ev(r, f"{b.entity_name}: balance with {a.entity_name}") for r in rows_b[:3]]
            metrics = {"entity_a": a.entity_name, "entity_b": b.entity_name, "net_a": fmt(net_a), "net_b": fmt(net_b), "rows_a": len(rows_a), "rows_b": len(rows_b)}
            key = f"mirror|{a.entity_id}|{b.entity_id}|{net_a}|{net_b}"
            if rows_a and rows_b:
                if abs(net_a + net_b) <= tol and net_a != 0:
                    if data.settings.get("rc_agreement", {}).get("enabled", True):
                        out.append(Draft("rc_agreement", RULE_BY_ID["rc_agreement"].severity, f"{pair} agree on their intercompany balance",
                                         f"{a.entity_name} carries {grouped(abs(net_a))} as a {_side_word(net_a)} with {b.entity_name}, and {b.entity_name} carries {grouped(abs(net_b))} as a {_side_word(net_b)}. They mirror each other.",
                                         "No action needed.", key, metrics, ev))
                elif enabled and net_a != 0 and abs(net_a - net_b) <= tol:
                    out.append(Draft("rc_mirror", RULE_BY_ID["rc_mirror"].severity, f"{pair} both record the balance as a {_side_word(net_a)}",
                                     f"{a.entity_name} and {b.entity_name} each carry {grouped(abs(net_a))} as a {_side_word(net_a)} with the other. One side should be a receivable and the other a payable.",
                                     "Check which entity actually owes the other, then correct the side that is wrong.", key, metrics, ev))
                elif enabled:
                    diff = abs(net_a + net_b)
                    out.append(Draft("rc_mirror", RULE_BY_ID["rc_mirror"].severity, f"{pair} differ by {grouped(diff)} on their intercompany balance",
                                     f"{a.entity_name} carries {grouped(abs(net_a))} as a {_side_word(net_a)} with {b.entity_name}; {b.entity_name} carries {grouped(abs(net_b))} as a {_side_word(net_b)} with {a.entity_name}. "
                                     f"They should be the same amount on opposite sides, and differ by {grouped(diff)}.",
                                     "Look for an invoice, payment or exchange-rate entry that one entity has booked and the other has not, and agree the balance between the two entities.",
                                     key, {**metrics, "difference": fmt(diff)}, ev))
            elif enabled:
                have, lack, rows = (a, b, rows_a) if rows_a else (b, a, rows_b)
                if lack.complete:
                    out.append(Draft("rc_mirror", RULE_BY_ID["rc_mirror"].severity, f"{have.entity_name} records a balance with {lack.entity_name}, but {lack.entity_name}'s books show none",
                                     f"{have.entity_name} has {len(rows)} account(s) with {lack.entity_name} in its books, but no account in {lack.entity_name}'s trial balance names {have.entity_name}.",
                                     f"Check that {lack.entity_name} has booked its side, or that the right trial balance was submitted for it.", key, metrics,
                                     [_ev(r, f"{have.entity_name}: balance with {lack.entity_name}") for r in rows[:3]]))
    return out


def reconcile(data: Data) -> list[Draft]:
    out: list[Draft] = mirror(data)
    enabled = lambda rid: data.settings.get(rid, {}).get("enabled", True)
    tol = _tol(data.settings, "rc_amount_unmatched")
    for doc in data.docs:
        comparable: list[TB] = []
        for tb in data.tbs:
            dc = {a.currency for a in doc.amounts if a.currency}
            if tb.currency and dc and tb.currency not in dc:
                if enabled("rc_currency"):
                    out.append(Draft("rc_currency", RULE_BY_ID["rc_currency"].severity, f"{doc.file_name} and {tb.sheet or tb.file_name} are in different currencies",
                                     f"The confirmation states {', '.join(sorted(dc))} but the trial balance is in {tb.currency}, so their amounts were not compared.",
                                     "Compare them after converting at the agreed rate, or check that the right files were submitted for this request.",
                                     f"{doc.id}|{tb.id}", {"document_currency": sorted(dc), "trial_balance_currency": tb.currency}, []))
                continue
            comparable.append(tb)
        for amt in doc.amounts:
            hits: list[tuple[TB, Row]] = []
            for tb in comparable:
                hits += [(tb, r) for r in tb.rows if abs(abs(_net(r)) - amt.value) <= tol and _net(r) != 0]
            doc_side = side_of(amt.context)
            if not hits:
                if comparable and all(t.complete for t in comparable) and enabled("rc_amount_unmatched"):  # never claim absence from a partial read
                    names = ", ".join(t.sheet or t.file_name for t in comparable)
                    out.append(Draft("rc_amount_unmatched", RULE_BY_ID["rc_amount_unmatched"].severity,
                                     f"{amt.text} in {doc.file_name} is not in the books",
                                     f"The balance confirmation states {amt.text}, but no account in the accepted trial balance(s) ({names}) has that balance.",
                                     "Check whether the right account or period was confirmed, whether the books are missing an entry, or whether the amount includes something else (interest, tax, an invoice not yet booked).",
                                     f"{doc.id}|{amt.value}", {"amount": fmt(amt.value), "currency": amt.currency, "document": doc.file_name, "compared": [t.sheet or t.file_name for t in comparable]}, []))
                continue
            # Prefer an account that looks intercompany / payable / receivable when several carry the same number.
            hits.sort(key=lambda h: (not (_INTERCO.search(h[1].name) or side_of(h[1].name)), h[1].source_row))
            tb, row = hits[0]
            acct_side = side_of(row.name) or ("payable" if _net(row) < 0 else "receivable")
            cp = _counterparty(row.name)
            names_signer = bool(cp) and cp.lower() in doc.excerpt.lower()
            where = f"{row.code} {row.name}".strip()
            if enabled("rc_direction") and doc_side and names_signer and acct_side == doc_side:
                out.append(Draft("rc_direction", RULE_BY_ID["rc_direction"].severity, f"{amt.text} is a {doc_side} on both sides",
                                 f"The confirmation describes {amt.text} as a {doc_side}, and account {where} in {tb.sheet or tb.file_name} also carries it as a {acct_side}. "
                                 f"The account names {cp}, who appears in the letter. The two parties to a balance should record opposite sides.",
                                 f"Check which entity signed the letter. If the letter is from {cp} and this trial balance is the other party's, one side is recorded in the wrong direction. "
                                 + (f"If it is the signer's own, this is not a problem. This trial balance was confirmed as belonging to {tb.entity_name}."
                                    if tb.entity_name else
                                    "If this trial balance is the signer's own, this is not a problem. This check cannot tell which entity a trial balance belongs to."),
                                 f"{doc.id}|{row.code}|{amt.value}",
                                 {"amount": fmt(amt.value), "document_side": doc_side, "account_side": acct_side, "account": where, "counterparty": cp},
                                 [_ev(row, f"Carried as a {acct_side}; the confirmation says {doc_side}")]))
            elif enabled("rc_agreement"):
                note = f"{amt.text} agrees with account {where} in {tb.sheet or tb.file_name}."
                if len(hits) > 1:
                    note += f" ({len(hits)} accounts carry this amount; the most likely one is shown.)"
                out.append(Draft("rc_agreement", RULE_BY_ID["rc_agreement"].severity, f"{amt.text} agrees with the books", note,
                                 "No action needed unless the account is not the one the confirmation relates to.", f"{doc.id}|{row.code}|{amt.value}",
                                 {"amount": fmt(amt.value), "account": where, "matches": len(hits), "direction_checked": bool(doc_side and names_signer)},
                                 [_ev(row, f"Balance {grouped(abs(_net(row)))} matches the confirmation")]))
    out.sort(key=lambda d: ({"error": 0, "warning": 1, "info": 2}[d.severity], d.rule_id, d.dedupe))
    return out


__all__ = ["RULES", "RULE_BY_ID", "Data", "fmt", "grouped", "load", "mirror", "names_entity", "reconcile"]
