from decimal import Decimal

import pytest

from taxops_agents.agents.extraction.amounts import fmt, parse_amount
from taxops_agents.agents.extraction.workbook import col_index, col_letter

D = Decimal


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        (1234, D("1234")), (1234.5, D("1234.5")), (D("10.25"), D("10.25")),
        ("1234", D("1234")), ("1,234", D("1234")), ("1,234,567", D("1234567")), ("1,234.56", D("1234.56")),
        ("1.234,56", D("1234.56")), ("1.234.567,89", D("1234567.89")), ("12,5", D("12.5")), ("1234,56", D("1234.56")),
        ("1.234.567", D("1234567")), ("12.5", D("12.5")),
        ("(1,234.50)", D("-1234.50")), ("-1,234.50", D("-1234.50")), ("1,234.50-", D("-1234.50")), ("−1,234", D("-1234")),
        ("$1,234.50", D("1234.50")), ("€ 1.234,50", D("1234.50")), ("1 234", D("1234")), ("USD 99", D("99")),
        ("1,234.50 CR", D("-1234.50")), ("1,234.50 DR", D("1234.50")), ("+5", D("5")),
    ],
)
def test_parses_real_world_formats(raw, expected):
    assert parse_amount(raw) == (expected, True)


@pytest.mark.parametrize("raw", [None, "", "  ", "-", "–", "n/a", "NIL"])
def test_blanks_are_ok_and_empty(raw):
    assert parse_amount(raw) == (None, True)


@pytest.mark.parametrize("raw", ["abc", "12abc", "1,2,3,x", "N/A!!", True, "--5", "1e99999", float("nan"), float("inf"), "9" * 30])
def test_unreadable_values_are_reported_not_guessed(raw):
    assert parse_amount(raw) == (None, False)


def test_never_uses_float_arithmetic():
    d, ok = parse_amount("0.1")
    d2, _ = parse_amount("0.2")
    assert ok and d + d2 == D("0.3")
    assert fmt(D("10.500")) == "10.5" and fmt(D("-0.00")) == "0" and fmt(D("1E+3")) == "1000" and fmt(None) == "0"


def test_column_letters_round_trip():
    for i in (0, 1, 25, 26, 27, 51, 52, 701, 702):
        assert col_index(col_letter(i)) == i
    assert col_letter(0) == "A" and col_letter(26) == "AA"
    with pytest.raises(ValueError):
        col_index("A1")
