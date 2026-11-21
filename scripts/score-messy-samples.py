"""Scores the extraction agent against samples/messy/truth.json using the PLAIN-CODE path only (no AI model).
Run from the repo root: /path/to/venv/python scripts/score-messy-samples.py"""
from __future__ import annotations

import json
import sys
from decimal import Decimal as D
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path[:0] = [str(ROOT / "services/agent-worker/src"), str(ROOT / "services/agent-worker/tests")]
from helpers import FakeFiles, context, payload  # noqa: E402

from taxops_agents.agents.extraction import ExtractionAgent  # noqa: E402
from taxops_agents.agents.validation.rules import Row, TBData, run_rules  # noqa: E402

DIR = ROOT / "samples/messy"
truth = json.loads((DIR / "truth.json").read_text())


def net(d: str, c: str) -> D:
    return D(d or "0") - D(c or "0")


total_ok = 0
for name, t in truth.items():
    f = FakeFiles((DIR / name).read_bytes(), name=name)
    ctx, _ = context(f, allow_llm=False)
    res = ExtractionAgent().run(ctx, payload(f, "xlsx"))
    print(f"\n=== {name}  [{t['currency']}] {res.meta.status}: {res.meta.detail}")
    if not res.proposals:
        print("   RESULT: nothing extracted"); continue
    # score the proposal that came closest (most matching accounts)
    best = None
    for pi, p in enumerate(res.proposals):
        rows = [r for r in res.rows if r.proposal_index == pi]
        got = {r.values.get("account_code", ""): net(r.values.get("debit", "0"), r.values.get("credit", "0")) for r in rows}
        want = {a["code"]: net(a["debit"], a["credit"]) for a in t["accounts"]}
        right = sum(1 for k, v in want.items() if got.get(k) == v)
        wrong = [k for k, v in want.items() if k in got and got[k] != v]
        missing = [k for k in want if k not in got]
        extra = [k for k in got if k not in want]
        cand = (right, p, rows, wrong, missing, extra)
        if best is None or right > best[0]:
            best = cand
    right, p, rows, wrong, missing, extra = best
    n = len(t["accounts"])
    print(f"   proposals: {len(res.proposals)}  confidence: {p.confidence}  method: {p.payload['method']}  header row: {p.payload['header_row']}")
    print(f"   mapping: " + ", ".join(f"{k}={v['header']!r}" for k, v in p.payload["columns"].items()))
    print(f"   accounts correct: {right}/{n}   wrong value: {wrong or '-'}   missing: {missing or '-'}   extra rows: {extra or '-'}")
    print(f"   stats: debit {p.payload['stats']['sum_debit']} credit {p.payload['stats']['sum_credit']} unreadable cells {p.payload['stats']['unparsed_cells']}")
    for note in p.payload["notes"]:
        print(f"   note: {note}")
    drafts, _ = run_rules(TBData(p.payload["sheet"], [Row(r.proposal_index + 1, r.sheet, r.source_row, r.values, r.cells, r.issues) for r in rows], p.payload["stats"], p.payload["metadata"]), {})
    print("   validation: " + ("; ".join(f"[{d.severity}] {d.title}" for d in drafts) or "no findings (correct: the data balances)"))
    if t.get("note"):
        print(f"   NOTE: {t['note']}")
    ok = right == n and not extra and not wrong
    total_ok += ok
    print("   VERDICT:", "PASS" if ok else "FAIL")
print(f"\n{total_ok}/{len(truth)} files extracted fully correctly")
