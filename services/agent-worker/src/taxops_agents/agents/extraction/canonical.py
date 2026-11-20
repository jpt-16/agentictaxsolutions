"""Canonical (standardized) schemas an extraction can target. Phase 3 ships the trial balance only."""
from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class CanonicalField:
    key: str
    label: str
    kind: str  # "text" | "amount"


@dataclass(frozen=True)
class CanonicalSchema:
    key: str
    label: str
    version: str
    fields: tuple[CanonicalField, ...]


# `balance` is an alternative to debit+credit (single signed column); output rows always carry debit and credit.
TRIAL_BALANCE = CanonicalSchema(
    key="trial_balance",
    label="Trial balance",
    version="1",
    fields=(
        CanonicalField("account_code", "Account code", "text"),
        CanonicalField("account_name", "Account name", "text"),
        CanonicalField("debit", "Debit", "amount"),
        CanonicalField("credit", "Credit", "amount"),
        CanonicalField("balance", "Balance (signed)", "amount"),
    ),
)

# What the standardized output rows contain.
OUTPUT_FIELDS = ("account_code", "account_name", "debit", "credit")
