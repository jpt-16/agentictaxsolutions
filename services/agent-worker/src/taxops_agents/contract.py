"""The contract every AI agent implements.

Design rules (see docs/architecture.md):
  * Agents never write business data. They return *proposals* that a human reviews.
  * Agents declare what they read and which events trigger them, so the runtime can enforce
    least privilege and so adding an agent never requires changing the platform core.
  * Numbers are computed by deterministic code, not by the model. The model interprets; code calculates.
"""
from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any, ClassVar, Generic, Literal, Protocol, TypeVar, runtime_checkable
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field

from .llm import LLMGateway

I = TypeVar("I", bound=BaseModel)
O = TypeVar("O", bound=BaseModel)

ProposalKind = Literal["extraction", "finding", "mapping", "suggestion"]
Severity = Literal["info", "warning", "error"]


class Evidence(BaseModel):
    """Points at the exact source of a claim so a reviewer can verify it (lineage)."""

    model_config = ConfigDict(frozen=True)
    file_id: UUID | None = None
    sheet: str | None = None
    cell_range: str | None = None
    note: str = ""


class Proposal(BaseModel):
    """A suggestion produced by an agent. Never applied automatically."""

    kind: ProposalKind
    title: str
    detail: str = ""
    payload: dict[str, Any] = Field(default_factory=dict)
    confidence: float = Field(ge=0.0, le=1.0)
    severity: Severity | None = None
    evidence: list[Evidence] = Field(default_factory=list)
    # Findings only: the rule that raised it, and the ACCEPTED extraction it was raised against.
    rule_id: str | None = None
    source_proposal_id: UUID | None = None


class FileMeta(BaseModel):
    """What the platform tells an agent about a file. Comes from the DB function bound to the job being worked."""

    model_config = ConfigDict(frozen=True)
    tenant_id: UUID
    file_id: UUID
    request_id: UUID
    item_id: UUID
    submission_id: UUID
    storage_key: str
    sha256: str
    original_name: str
    content_type: str
    size_bytes: int
    ai_extraction_enabled: bool
    external_llm_enabled: bool


class FileBlob(BaseModel):
    model_config = ConfigDict(frozen=True)
    meta: FileMeta
    data: bytes


@runtime_checkable
class FileAccess(Protocol):
    """Job-scoped file access: an agent can only open the file its job refers to, and bytes are hash-verified."""

    def open(self, file_id: UUID) -> FileBlob: ...


class SourceProposal(BaseModel):
    """An accepted extraction, as handed to a validation run (bound to the job being worked)."""

    model_config = ConfigDict(frozen=True)
    id: UUID
    schema_key: str | None
    payload: dict[str, Any]
    rows: list[dict[str, Any]]
    rule_settings: dict[str, dict[str, Any]]  # rule_id -> {"enabled": bool, "params": {...}}
    external_llm_enabled: bool
    request_reference: str
    tax_year: int


@runtime_checkable
class ProposalAccess(Protocol):
    def open(self, proposal_id: UUID) -> SourceProposal | None: ...


class RunContext(BaseModel):
    """Everything an agent may know about the run. Always tenant-scoped."""

    model_config = ConfigDict(arbitrary_types_allowed=True)
    tenant_id: UUID
    run_id: UUID
    triggered_by_event: str
    llm: LLMGateway
    files: FileAccess | None = None
    proposals: ProposalAccess | None = None
    # False when the tenant has not allowed content to be sent to an external model provider.
    allow_external_llm: bool = False


class ExtractedRow(BaseModel):
    """One standardized row, traceable to the exact source cells it came from."""

    proposal_index: int
    sheet: str
    source_row: int
    values: dict[str, Any]
    cells: dict[str, str]
    issues: list[str] = Field(default_factory=list)


class RunMeta(BaseModel):
    status: Literal["succeeded", "skipped", "failed"] = "succeeded"
    detail: str = ""
    model: str | None = None
    prompt_version: str | None = None
    llm_calls: int = 0
    duration_ms: int = 0


class AgentResult(BaseModel):
    """The standard return type for agents whose output is persisted by the worker for human review."""

    proposals: list[Proposal] = Field(default_factory=list)
    rows: list[ExtractedRow] = Field(default_factory=list)
    meta: RunMeta = Field(default_factory=RunMeta)


class AgentSpec(BaseModel):
    """Static, declarative description of an agent."""

    model_config = ConfigDict(frozen=True)
    name: str = Field(pattern=r"^[a-z][a-z0-9_]{2,40}$")
    version: str = Field(pattern=r"^\d+\.\d+\.\d+$")
    description: str
    triggers: tuple[str, ...]  # event names, e.g. "submission.uploaded"
    reads: tuple[str, ...] = ()  # data scopes, e.g. "submission.files"


class Agent(ABC, Generic[I, O]):
    spec: ClassVar[AgentSpec]
    input_model: ClassVar[type[BaseModel]]
    output_model: ClassVar[type[BaseModel]]

    @abstractmethod
    def run(self, ctx: RunContext, payload: I) -> O:
        """Do the work and return a validated output (typically containing proposals)."""
