"""Extraction agent: standardizes trial-balance spreadsheets into reviewable proposals.

Flow per sheet: heuristic header match -> (only if unsure) LLM mapping -> VERIFY against the data -> deterministic row
extraction -> proposal with confidence, stats and per-row lineage. The model never sees or produces amounts it is trusted on.
"""
from __future__ import annotations

import time
from typing import Any

from ...contract import Agent, AgentResult, AgentSpec, Evidence, ExtractedRow, Proposal, RunContext, RunMeta
from ...events import FileUploaded
from ...llm import LLMError
from .amounts import parse_amount
from .canonical import OUTPUT_FIELDS, TRIAL_BALANCE
from .mapping import (
    LLM_THRESHOLD,
    PROMPT_VERSION,
    Mapping,
    Verification,
    confidence,
    extract_rows,
    find_other_tables,
    heuristic_mapping,
    llm_mapping,
    metadata_hints,
    verify_mapping,
)
from .workbook import Grid, WorkbookError, col_letter, read_grids

AGENT_VERSION = "1.0.0"
MAX_ROWS_PER_SHEET = 5000
MAX_ROWS_TOTAL = 20000
SUPPORTED = {"xlsx", "csv"}


def _kind_of(name: str, declared: str) -> str:
    ext = name.rsplit(".", 1)[-1].lower() if "." in name else ""
    return ext if ext in SUPPORTED else declared


def _looks_tabular(grid: Grid) -> bool:
    """Enough numbers in enough columns that a human would call it a data table (not a cover page)."""
    width = max((len(r) for r in grid.rows), default=0)

    def is_number(c: object) -> bool:
        if isinstance(c, int | float) and not isinstance(c, bool):
            return True
        # Amounts stored as TEXT ("412.350,75", "S$1,200.00") are very common in exports from other countries.
        return isinstance(c, str) and any(ch.isdigit() for ch in c) and parse_amount(c)[0] is not None

    numbers = sum(is_number(c) for r in grid.rows for c in r)
    return len(grid.rows) >= 3 and width >= 3 and numbers >= 4


def build_proposal(grid: Grid, m: Mapping, v: Verification, budget: int, index: int, file_id: Any, notes: list[str] | None = None, label: str | None = None) -> tuple[Proposal, list[ExtractedRow]] | None:
    """Deterministic extraction + proposal for a chosen (and already verified) mapping. Shared by the automatic and manual paths."""
    ex = extract_rows(grid, m, budget)
    if not ex.rows:
        return None
    conf = confidence(m, v)
    notes = [*m.notes, *(notes or []), *ex.notes]
    hints = metadata_hints(grid, m.header_row, window=6 if label else None, entity=label)
    n_issue_rows = ex.stats["rows_with_issues"]
    warn = conf < 0.8 or n_issue_rows > 0 or ex.stats.get("totals_mismatch") or grid.truncated
    if grid.truncated:
        notes.append("The sheet is very large; only the first rows were read.")
    header_cells = f"{col_letter(min(m.columns.values()))}{m.header_row}:{col_letter(max(m.columns.values()))}{m.header_row}"
    how = {"llm": "AI-assisted", "manual": "reviewer-corrected"}.get(m.method, "header")
    proposal = Proposal(
        kind="extraction", title=f"Trial balance – {label or grid.name}",
        detail=f"{ex.stats['row_count']} accounts read via {how} mapping" + (f"; {n_issue_rows} row(s) need a look" if n_issue_rows else "") + ".",
        payload={
            "schema": TRIAL_BALANCE.key, "schema_version": TRIAL_BALANCE.version, "sheet": label or grid.name, "method": m.method, "header_row": m.header_row,
            "fields": [{"key": k, "label": next(f.label for f in TRIAL_BALANCE.fields if f.key == k)} for k in OUTPUT_FIELDS],
            "columns": {f: {"letter": col_letter(i), "header": m.headers.get(f, "")} for f, i in m.columns.items()},
            "stats": ex.stats, "metadata": hints, "notes": notes, "parse_rate": v.parse_rate, "file_id": str(file_id),
        },
        confidence=conf, severity="warning" if warn else "info",
        evidence=[Evidence(sheet=grid.name, cell_range=header_cells, note="Header row used for column mapping")],
    )
    return proposal, [ExtractedRow(proposal_index=index, sheet=grid.name, **{k: r[k] for k in ("source_row", "values", "cells", "issues")}) for r in ex.rows]


class ExtractionAgent(Agent[FileUploaded, AgentResult]):
    spec = AgentSpec(
        name="extraction", version=AGENT_VERSION,
        description="Standardizes trial-balance spreadsheets into reviewable, source-linked proposals.",
        triggers=("file.uploaded",), reads=("submission.files",),
    )
    input_model = FileUploaded
    output_model = AgentResult

    def run(self, ctx: RunContext, payload: FileUploaded) -> AgentResult:
        t0 = time.monotonic()
        if ctx.files is None:
            raise RuntimeError("ExtractionAgent requires file access.")
        blob = ctx.files.open(payload.fileId)
        meta = blob.meta
        elapsed = lambda: int((time.monotonic() - t0) * 1000)

        if not meta.ai_extraction_enabled:
            return AgentResult(meta=RunMeta(status="skipped", detail="AI extraction is not enabled for this tenant.", duration_ms=elapsed()))
        kind = _kind_of(meta.original_name, payload.kind)
        if kind not in SUPPORTED:
            return AgentResult(meta=RunMeta(status="skipped", detail=f"No extractor for {kind} files.", duration_ms=elapsed()))
        try:
            grids = read_grids(blob.data, kind)
        except WorkbookError as e:
            return AgentResult(meta=RunMeta(status="failed", detail=str(e), duration_ms=elapsed()))

        proposals: list[Proposal] = []
        rows: list[ExtractedRow] = []
        llm_calls, skipped_sheets, needs_ai = 0, 0, 0
        reasons: list[str] = []
        for grid in grids:
            budget = min(MAX_ROWS_PER_SHEET, MAX_ROWS_TOTAL - len(rows))
            if budget <= 0:
                skipped_sheets += 1
                continue
            made, calls, wanted_ai, why = self._sheet(ctx, blob.meta.file_id, grid, budget, len(proposals))
            llm_calls += calls
            needs_ai += wanted_ai
            if why and why not in reasons:
                reasons.append(why)
            if made is None:
                skipped_sheets += 1
                continue
            prop, new_rows = made
            proposals.append(prop)
            rows.extend(new_rows)
            # More tables stacked in the same sheet (e.g. one per entity): each becomes its OWN proposal, never merged into the first.
            for n, extra in enumerate(self._more_tables(grid, prop, blob.meta.file_id, budget - len(new_rows), len(proposals)), start=2):
                proposals.append(extra[0]); rows.extend(extra[1])

        detail = (f"Extracted {len(proposals)} trial balance(s) from {len(grids)} sheet(s)" if proposals
                  else f"No trial balance found in {len(grids)} sheet(s)")
        if proposals and skipped_sheets:
            detail += f"; {skipped_sheets} sheet(s) not recognized"
        if needs_ai:
            detail += f". {needs_ai} sheet(s) look like data tables but their headers were not recognized by the built-in matching. Why the AI model did not help: " + "; ".join(reasons)
        return AgentResult(
            proposals=proposals, rows=rows,
            meta=RunMeta(status="succeeded", detail=detail, model=getattr(ctx.llm, "model", None) if llm_calls else None,
                         prompt_version=PROMPT_VERSION if llm_calls else None, llm_calls=llm_calls, duration_ms=elapsed()),
        )

    # ------------------------------------------------------------------------------------------------
    def _more_tables(self, grid: Grid, first: Proposal, file_id: Any, budget: int, index: int) -> list[tuple[Proposal, list[ExtractedRow]]]:
        """Header-matched tables further down the same sheet. Deterministic only (no model call for secondary tables)."""
        out: list[tuple[Proposal, list[ExtractedRow]]] = []
        if budget <= 0:
            return out
        header_row = first.payload["header_row"]
        base = heuristic_mapping(grid, header_row - 1, header_row)
        if base is None:
            return out
        starts = find_other_tables(grid, base)
        for k, ri in enumerate(starts):
            stop = starts[k + 1] if k + 1 < len(starts) else None
            m = heuristic_mapping(grid, ri, ri + 1)
            if m is None or not m.complete:
                continue
            m.end_row = stop
            v = verify_mapping(grid, m)
            if not v.ok:
                continue
            made = build_proposal(grid, m, v, budget, index + len(out), file_id, [f"A second table starts at sheet row {ri + 1}; it was read separately."], label=f"{grid.name} (table {k + 2})")
            if made:
                out.append(made); budget -= len(made[1])
        if out:
            first.payload["notes"].append(f"This sheet holds {len(out) + 1} tables; each was read separately. This is the first (header on row {header_row}).")
        return out

    def _sheet(self, ctx: RunContext, file_id: Any, grid: Grid, budget: int, index: int) -> tuple[tuple[Proposal, list[ExtractedRow]] | None, int, int, str | None]:
        """Returns (result, model calls made, 1 if a table-like sheet could not be read, why the model did not help)."""
        if not grid.rows:
            return None, 0, 0, None
        calls = 0
        why: str | None = None
        notes: list[str] = []
        chosen: tuple[Mapping, Verification] | None = None

        h = heuristic_mapping(grid)
        hv = verify_mapping(grid, h) if h else None
        if h and hv and hv.ok and confidence(h, hv) >= LLM_THRESHOLD:
            chosen = (h, hv)
        else:
            # Unsure: ask the model, but only if this tenant allows it. Its answer must still verify.
            try:
                calls += 1
                lm = llm_mapping(ctx, grid)
            except LLMError as e:
                calls -= 1
                lm = None
                why = f"AI-assisted mapping was not available: {e}"
                if h is not None:
                    notes.append(f"AI-assisted mapping was not used: {e}")
            if lm is None and why is None:
                why = "the AI model did not recognise a trial balance in the sheet"
            if lm is not None:
                lv = verify_mapping(grid, lm)
                if lv.ok:
                    chosen = (lm, lv)
                else:
                    why = "the AI's column mapping was discarded because it did not match the data: " + " ".join(lv.reasons)
                    notes.append("The AI mapping was discarded because it did not match the data: " + " ".join(lv.reasons))
            if chosen is None and h and hv and hv.ok:
                chosen = (h, hv)  # low-confidence heuristic answer, flagged for the reviewer
        if chosen is None:
            return None, calls, int(bool(why) and _looks_tabular(grid)), why

        m, v = chosen
        stacked = find_other_tables(grid, m)
        if stacked:
            m.end_row = stacked[0]  # this table stops where the next one starts
            v = verify_mapping(grid, m)
        made = build_proposal(grid, m, v, budget, index, file_id, notes)
        return (made, calls, 0, None) if made else (None, calls, 0, None)
