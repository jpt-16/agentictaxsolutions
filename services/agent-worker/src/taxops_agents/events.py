"""Event payload contracts shared with the TypeScript app (see packages/services/src/requests.ts).

The app enqueues these inside the same transaction as the change that caused them. Keep field names in sync;
`tests/test_events.py` pins the exact wire shape.
"""
from __future__ import annotations

from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field


class FileUploaded(BaseModel):
    model_config = ConfigDict(extra="forbid")
    fileId: UUID
    submissionId: UUID
    itemId: UUID
    requestId: UUID
    kind: Literal["xlsx", "csv", "pdf", "docx", "txt", "png", "jpg"]


class ProposalAccepted(BaseModel):
    """Enqueued when a person accepts an extraction; triggers validation (trial balances) and reconciliation (either kind)."""

    model_config = ConfigDict(extra="forbid")
    proposalId: UUID
    fileId: UUID
    requestId: UUID
    itemId: UUID
    schema_: Literal["trial_balance", "supporting_document"] = Field(alias="schema")


class ExtractionRemap(BaseModel):
    """A reviewer corrected the column mapping for one sheet; re-extract it deterministically with their mapping."""

    model_config = ConfigDict(extra="forbid")
    fileId: UUID
    submissionId: UUID
    itemId: UUID
    requestId: UUID
    kind: Literal["xlsx", "csv"]
    sheet: str = Field(min_length=1, max_length=200)
    headerRow: int = Field(ge=1, le=1000)
    columns: dict[Literal["account_code", "account_name", "debit", "credit", "balance"], str]
    requestedBy: UUID


EVENT_MODELS: dict[str, type[BaseModel]] = {"file.uploaded": FileUploaded, "proposal.accepted": ProposalAccepted, "extraction.remap": ExtractionRemap}
