"""Every rule any agent exposes to tenants (Settings lists these), mirrored by schemas/fixtures/validation_rules.json."""
from __future__ import annotations

from .agents.reconciliation.rules import RULES as RECONCILIATION_RULES
from .agents.validation.rules import RULES as VALIDATION_RULES


def rule_catalog() -> list[dict]:
    return [{"id": r.id, "name": r.name, "description": r.description, "severity": r.severity, "params": r.params} for r in (*VALIDATION_RULES, *RECONCILIATION_RULES)]
