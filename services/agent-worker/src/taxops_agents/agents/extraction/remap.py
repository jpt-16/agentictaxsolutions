"""Re-extraction with a REVIEWER-supplied column mapping.

A person looked at the sheet and said which column is which. We do not take that on faith either: the mapping is verified
against the data exactly like a model's answer would be, and rows are extracted deterministically.
"""
from __future__ import annotations

import time

from ...contract import Agent, AgentResult, AgentSpec, RunContext, RunMeta
from ...events import ExtractionRemap
from .agent import AGENT_VERSION, MAX_ROWS_PER_SHEET, build_proposal
from .mapping import Mapping, verify_mapping
from .workbook import WorkbookError, col_index, read_grids


class RemapAgent(Agent[ExtractionRemap, AgentResult]):
    spec = AgentSpec(
        name="extraction_remap", version=AGENT_VERSION,
        description="Re-extracts one sheet using a column mapping chosen by a reviewer.",
        triggers=("extraction.remap",), reads=("submission.files",),
    )
    input_model = ExtractionRemap
    output_model = AgentResult

    def run(self, ctx: RunContext, payload: ExtractionRemap) -> AgentResult:
        t0 = time.monotonic()
        elapsed = lambda: int((time.monotonic() - t0) * 1000)
        fail = lambda why: AgentResult(meta=RunMeta(status="failed", detail=why, duration_ms=elapsed()))
        if ctx.files is None:
            raise RuntimeError("RemapAgent requires file access.")
        blob = ctx.files.open(payload.fileId)
        if not blob.meta.ai_extraction_enabled:
            # The tenant's switch covers every agent that reads uploaded files, including reviewer-directed re-extraction.
            return AgentResult(meta=RunMeta(status="skipped", detail="AI extraction is not enabled for this tenant.", duration_ms=elapsed()))
        try:
            grids = read_grids(blob.data, payload.kind)
        except WorkbookError as e:
            return fail(str(e))
        grid = next((g for g in grids if g.name == payload.sheet), None)
        if grid is None:
            return fail(f"Sheet “{payload.sheet}” was not found in the file.")
        try:
            cols = {f: col_index(letter) for f, letter in payload.columns.items()}
        except ValueError:
            return fail("One of the chosen columns is not a valid column letter.")
        if not 1 <= payload.headerRow <= len(grid.rows):
            return fail("The header row is outside the sheet.")
        header = grid.rows[payload.headerRow - 1]
        m = Mapping(payload.headerRow, cols, "manual", 1.0, ["Column mapping was set by a reviewer."],
                    {f: str(header[i]) if i < len(header) else "" for f, i in cols.items()})
        v = verify_mapping(grid, m)
        if not v.ok:
            return fail("The chosen columns do not match the data: " + " ".join(v.reasons))
        made = build_proposal(grid, m, v, MAX_ROWS_PER_SHEET, 0, blob.meta.file_id, ["Corrected by a reviewer; re-extracted from the source file."])
        if made is None:
            return fail("No account rows were found below the chosen header row.")
        return AgentResult(proposals=[made[0]], rows=made[1], meta=RunMeta(status="succeeded", detail=f"Re-extracted “{payload.sheet}” with a reviewer mapping", duration_ms=elapsed()))
