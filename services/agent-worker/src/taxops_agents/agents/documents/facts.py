"""Deterministic facts pulled from document text. Nothing here is interpreted by a model."""
from __future__ import annotations

import re
from dataclasses import dataclass

_CUR = r"(?:USD|EUR|GBP|CAD|AUD|CHF|JPY|SGD|INR|CNY|US\$|\$|€|£)"
_NUM = r"\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?"
AMOUNT = re.compile(rf"(?<![\w.])(?:{_CUR}\s?(?:{_NUM})|(?:{_NUM})\s?(?:USD|EUR|GBP|CAD|AUD|CHF|JPY|SGD|INR|CNY))(?![\w])")
MONTHS = r"(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)"
DATE = re.compile(rf"\b(?:\d{{4}}-\d{{2}}-\d{{2}}|\d{{1,2}}\s{MONTHS}\.?,?\s\d{{4}}|{MONTHS}\.?\s\d{{1,2}},?\s\d{{4}}|\d{{1,2}}/\d{{1,2}}/\d{{4}})\b", re.IGNORECASE)
YEAR = re.compile(r"\b(?:FY\s?)?(20\d{2}|19\d{2})\b")
SIGNATURE = re.compile(r"\b(?:signed|signature|authori[sz]ed signatory|/s/|sincerely|yours faithfully|on behalf of)\b", re.IGNORECASE)

DOC_TYPES: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("Balance confirmation", re.compile(r"balance confirmation|confirm(?:s|ation of)? (?:the )?balance|audit confirmation", re.IGNORECASE)),
    ("Invoice", re.compile(r"\binvoice\b|\bbill to\b", re.IGNORECASE)),
    ("Bank statement", re.compile(r"bank statement|account statement|opening balance.*closing balance", re.IGNORECASE | re.DOTALL)),
    ("Agreement or contract", re.compile(r"\bagreement\b|\bcontract\b|\bhereinafter\b|\bwhereas\b", re.IGNORECASE)),
    ("Board or meeting minutes", re.compile(r"\bminutes\b.*\b(?:meeting|board)\b|\bresolved\b", re.IGNORECASE | re.DOTALL)),
    ("Tax return or filing", re.compile(r"tax return|form \d{3,4}|filing (?:period|status)", re.IGNORECASE)),
    ("Transfer pricing documentation", re.compile(r"transfer pricing|arm'?s[- ]length|comparable", re.IGNORECASE)),
)


@dataclass
class Facts:
    amounts: list[str]
    dates: list[str]
    years: list[str]
    signature_cues: int
    document_type: str


def _uniq(items: list[str], limit: int) -> list[str]:
    seen: dict[str, None] = {}
    for i in items:
        seen.setdefault(re.sub(r"\s+", " ", i).strip(), None)
        if len(seen) >= limit:
            break
    return list(seen)


def numbers_in(text: str) -> set[str]:
    """Every digit run in the text, normalized (no thousands separators), for verifying that a claim is grounded."""
    return {m.replace(",", "") for m in re.findall(r"\d[\d,]*(?:\.\d+)?", text)}


def extract_facts(text: str) -> Facts:
    doc_type = next((name for name, pat in DOC_TYPES if pat.search(text)), "Other")
    years = [m.group(1) for m in YEAR.finditer(text)]
    return Facts(
        amounts=_uniq([m.group(0) for m in AMOUNT.finditer(text)], 40),
        dates=_uniq([m.group(0) for m in DATE.finditer(text)], 25),
        years=sorted(set(years))[:10],
        signature_cues=len(SIGNATURE.findall(text)),
        document_type=doc_type,
    )
