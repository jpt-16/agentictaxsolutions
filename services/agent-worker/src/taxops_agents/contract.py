"""The contract every AI agent implements.

Design rules (see docs/architecture.md):
  * Agents never write business data. They return *proposals* that a human reviews.
  * Agents declare what they read and which events trigger them, so the runtime can enforce
    least privilege and so adding an agent never requires changing the platform core.
  * Numbers are computed by deterministic code, not by the model. The model interprets; code calculates.
"""
from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any, ClassVar, Generic, Literal, TypeVar
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


class RunContext(BaseModel):
    """Everything an agent may know about the run. Always tenant-scoped."""

    model_config = ConfigDict(arbitrary_types_allowed=True)
    tenant_id: UUID
    run_id: UUID
    triggered_by_event: str
    llm: LLMGateway


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
