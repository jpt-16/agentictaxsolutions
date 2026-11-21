"""Deterministic amount parsing. Money is never handled by the LLM and never as a float."""
from __future__ import annotations

import re
from decimal import Decimal, InvalidOperation

# Symbols (including prefixed ones such as S$, R$, MX$, C$) and ISO codes. Stripped before the number is read.
_CURRENCY = re.compile(r"\b[A-Z]{1,3}\$|[€£$¥₹]|\b(?:USD|EUR|GBP|CAD|AUD|NZD|SGD|JPY|BRL|CHF|CNY|INR|MXN|SEK|NOK|DKK|PLN|PEN|COP|CLP|ARS|ZAR|HKD|AED|TRY|CZK|HUF|RON)\b", re.IGNORECASE)
_BLANKS = {"", "-", "–", "—", "n/a", "na", "nil"}
MAX_ABS = Decimal("1e15")


def parse_amount(value: object) -> tuple[Decimal | None, bool]:
    """Returns (amount, ok). Blank cells are (None, True); unreadable text is (None, False)."""
    if value is None:
        return None, True
    if isinstance(value, bool):
        return None, False
    if isinstance(value, int | float | Decimal):
        try:
            d = Decimal(str(value))
        except InvalidOperation:
            return None, False
        return (d, True) if d.is_finite() and abs(d) <= MAX_ABS else (None, False)

    text = str(value).strip().replace(" ", " ").replace("−", "-")
    if text.lower() in _BLANKS:
        return None, True

    negative = False
    upper = text.upper()
    if upper.endswith(" CR") or upper.endswith("CR") and upper[:-2].strip()[-1:].isdigit():
        negative, text = True, text[:-2].strip()
    elif upper.endswith(" DR") or upper.endswith("DR") and upper[:-2].strip()[-1:].isdigit():
        text = text[:-2].strip()
    text = _CURRENCY.sub("", text).strip()
    if text.startswith("(") and text.endswith(")"):
        negative, text = True, text[1:-1].strip()
    if text.endswith("-"):
        negative, text = True, text[:-1].strip()
    if text.startswith("-"):
        negative, text = True, text[1:].strip()
    elif text.startswith("+"):
        text = text[1:].strip()
    text = text.replace(" ", "")
    if not text or not re.fullmatch(r"[\d.,]+", text):
        return None, False

    last_dot, last_comma = text.rfind("."), text.rfind(",")
    if last_dot != -1 and last_comma != -1:
        decimal_sep = "." if last_dot > last_comma else ","
    elif last_comma != -1:
        # "1,234" or "1,234,567" are thousands; "12,5" / "1234,56" are decimal commas.
        decimal_sep = None if re.fullmatch(r"\d{1,3}(,\d{3})+", text) else ","
    elif last_dot != -1:
        decimal_sep = None if re.fullmatch(r"\d{1,3}(\.\d{3}){2,}", text) else "."
    else:
        decimal_sep = None

    if decimal_sep:
        whole, _, frac = text.rpartition(decimal_sep)
        whole = re.sub(r"[.,]", "", whole)
        if not re.fullmatch(r"\d*", whole) or not re.fullmatch(r"\d+", frac):
            return None, False
        text = f"{whole or '0'}.{frac}"
    else:
        text = re.sub(r"[.,]", "", text)
    try:
        d = Decimal(text)
    except InvalidOperation:
        return None, False
    d = -d if negative else d
    return (d, True) if abs(d) <= MAX_ABS else (None, False)


def fmt(d: Decimal | None) -> str:
    """Canonical string form for JSON: plain decimal, no exponent, no float rounding."""
    if d is None or d == 0:
        return "0"  # never "-0"
    s = format(d, "f")
    if "." in s:
        s = s.rstrip("0").rstrip(".")
    return s or "0"
