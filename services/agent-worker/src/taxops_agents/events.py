"""Event payload contracts shared with the TypeScript app (see packages/services/src/requests.ts).

The app enqueues these inside the same transaction as the change that caused them. Keep field names in sync;
`tests/test_events.py` pins the exact wire shape.
"""
from __future__ import annotations

from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict


class FileUploaded(BaseModel):
    model_config = ConfigDict(extra="forbid")
    fileId: UUID
    submissionId: UUID
    itemId: UUID
    requestId: UUID
    kind: Literal["xlsx", "csv", "pdf", "docx", "txt", "png", "jpg"]


EVENT_MODELS: dict[str, type[BaseModel]] = {"file.uploaded": FileUploaded}
