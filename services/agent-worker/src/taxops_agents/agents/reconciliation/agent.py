"""Reconciliation agent: compares a person-accepted balance confirmation with the person-accepted trial balances of the SAME request.

It only ever reads work a person has already accepted, through one size-capped database function bound to the job it holds. It raises
findings for a person to confirm or dismiss. It never changes numbers, and no model is involved in deciding whether figures agree.
"""
from __future__ import annotations

import time

from ...contract import Agent, AgentResult, AgentSpec, Evidence, Proposal, RunContext, RunMeta
from ...events import ProposalAccepted
from .rules import RULE_BY_ID, load, reconcile

AGENT_VERSION = "1.0.0"
EXPLANATION = "This is a deterministic comparison of figures a person has already accepted."


class ReconciliationAgent(Agent[ProposalAccepted, AgentResult]):
    spec = AgentSpec(
        name="reconciliation", version=AGENT_VERSION,
        description="Compares accepted balance confirmations with accepted trial balances in the same request and raises reviewable findings.",
        triggers=("proposal.accepted",), reads=("proposals.accepted",),
    )
    input_model = ProposalAccepted
    output_model = AgentResult

    def run(self, ctx: RunContext, payload: ProposalAccepted) -> AgentResult:
        t0 = time.monotonic()
        elapsed = lambda: int((time.monotonic() - t0) * 1000)
        if ctx.related is None:
            raise RuntimeError("ReconciliationAgent requires related-proposal access.")
        rel = ctx.related.related(payload.proposalId)
        if rel is None:
            return AgentResult(meta=RunMeta(status="skipped", detail="No accepted extraction found for this event.", duration_ms=elapsed()))
        data = load(rel.proposals)
        data.settings = rel.rule_settings
        if not data.docs or not data.tbs:
            need = "accepted balance confirmation" if not data.docs else "accepted trial balance"
            return AgentResult(meta=RunMeta(status="skipped", detail=f"Nothing to reconcile yet: this request has no {need}.", duration_ms=elapsed()))
        drafts = reconcile(data)
        proposals = []
        for d in drafts:
            spec = RULE_BY_ID[d.rule_id]
            proposals.append(Proposal(
                kind="finding", title=d.title[:300], detail=d.summary, confidence=spec.confidence, severity=d.severity,  # type: ignore[arg-type]
                rule_id=d.rule_id, source_proposal_id=payload.proposalId,
                payload={
                    "schema": "reconciliation", "sheet": d.evidence[0]["sheet"] if d.evidence else "", "rule_id": d.rule_id, "rule_name": spec.name,
                    "summary": d.summary, "explanation": EXPLANATION, "explanation_source": "template", "suggestion": d.suggestion,
                    "evidence": d.evidence, "metrics": d.metrics, "dedupe": d.dedupe, "source_proposal_id": str(payload.proposalId),
                },
                evidence=[Evidence(sheet=e["sheet"], cell_range=",".join(e["cells"]), note=e["note"]) for e in d.evidence],
            ))
        counts = {s: sum(1 for d in drafts if d.severity == s) for s in ("error", "warning", "info")}
        detail = (f"Compared {len(data.docs)} confirmation(s) with {len(data.tbs)} trial balance(s): "
                  + (", ".join(f"{n} {s}" for s, n in counts.items() if n) if drafts else "no findings"))
        return AgentResult(proposals=proposals, meta=RunMeta(status="succeeded", detail=detail, duration_ms=elapsed()))
