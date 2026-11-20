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
from .canonical import OUTPUT_FIELDS, TRIAL_BALANCE
from .mapping import (
    LLM_THRESHOLD,
    PROMPT_VERSION,
    Mapping,
    Verification,
    confidence,
    extract_rows,
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
    numbers = sum(isinstance(c, int | float) and not isinstance(c, bool) for r in grid.rows for c in r)
    return len(grid.rows) >= 3 and width >= 3 and numbers >= 4


def build_proposal(grid: Grid, m: Mapping, v: Verification, budget: int, index: int, file_id: Any, notes: list[str] | None = None) -> tuple[Proposal, list[ExtractedRow]] | None:
    """Deterministic extraction + proposal for a chosen (and already verified) mapping. Shared by the automatic and manual paths."""
    ex = extract_rows(grid, m, budget)
    if not ex.rows:
        return None
    conf = confidence(m, v)
    notes = [*m.notes, *(notes or []), *ex.notes]
    hints = metadata_hints(grid, m.header_row)
    n_issue_rows = ex.stats["rows_with_issues"]
    warn = conf < 0.8 or n_issue_rows > 0 or ex.stats.get("totals_mismatch") or grid.truncated
    if grid.truncated:
        notes.append("The sheet is very large; only the first rows were read.")
    header_cells = f"{col_letter(min(m.columns.values()))}{m.header_row}:{col_letter(max(m.columns.values()))}{m.header_row}"
    how = {"llm": "AI-assisted", "manual": "reviewer-corrected"}.get(m.method, "header")
    proposal = Proposal(
        kind="extraction", title=f"Trial balance – {grid.name}",
        detail=f"{ex.stats['row_count']} accounts read via {how} mapping" + (f"; {n_issue_rows} row(s) need a look" if n_issue_rows else "") + ".",
        payload={
            "schema": TRIAL_BALANCE.key, "schema_version": TRIAL_BALANCE.version, "sheet": grid.name, "method": m.method, "header_row": m.header_row,
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
        for grid in grids:
            budget = min(MAX_ROWS_PER_SHEET, MAX_ROWS_TOTAL - len(rows))
            if budget <= 0:
                skipped_sheets += 1
                continue
            made, calls, wanted_ai = self._sheet(ctx, blob.meta.file_id, grid, budget, len(proposals))
            llm_calls += calls
            needs_ai += wanted_ai
            if made is None:
                skipped_sheets += 1
                continue
            prop, new_rows = made
            proposals.append(prop)
            rows.extend(new_rows)

        detail = (f"Extracted {len(proposals)} trial balance(s) from {len(grids)} sheet(s)" if proposals
                  else f"No trial balance found in {len(grids)} sheet(s)")
        if proposals and skipped_sheets:
            detail += f"; {skipped_sheets} sheet(s) not recognized"
        if needs_ai:
            detail += (f". {needs_ai} sheet(s) look like data tables but their headers were not recognized, and AI-assisted mapping "
                       "was not available (tenant setting, missing API key, or provider error)")
        return AgentResult(
            proposals=proposals, rows=rows,
            meta=RunMeta(status="succeeded", detail=detail, model=getattr(ctx.llm, "model", None) if llm_calls else None,
                         prompt_version=PROMPT_VERSION if llm_calls else None, llm_calls=llm_calls, duration_ms=elapsed()),
        )

    # ------------------------------------------------------------------------------------------------
    def _sheet(self, ctx: RunContext, file_id: Any, grid: Grid, budget: int, index: int) -> tuple[tuple[Proposal, list[ExtractedRow]] | None, int, int]:
        if not grid.rows:
            return None, 0, 0
        calls = 0
        ai_unavailable = False
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
                ai_unavailable = True
                if h is not None:
                    notes.append(f"AI-assisted mapping was not used: {e}")
            if lm is not None:
                lv = verify_mapping(grid, lm)
                if lv.ok:
                    chosen = (lm, lv)
                else:
                    notes.append("The AI mapping was discarded because it did not match the data: " + " ".join(lv.reasons))
            if chosen is None and h and hv and hv.ok:
                chosen = (h, hv)  # low-confidence heuristic answer, flagged for the reviewer
        if chosen is None:
            return None, calls, int(ai_unavailable and _looks_tabular(grid))

        m, v = chosen
        made = build_proposal(grid, m, v, budget, index, file_id, notes)
        return (made, calls, 0) if made else (None, calls, 0)
