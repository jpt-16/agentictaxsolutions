"""Queue worker: claims jobs, routes each event to the agents registered for it, and reports the outcome.

Security posture:
  * connects as `taxops_worker`, a role with NO table privileges. It can only call jobs_claim / jobs_complete / jobs_fail.
  * agents get a tenant-scoped RunContext; they emit proposals and never write business data directly.
  * failures record only the exception *type* and our own messages, never payloads or model output.
"""
from __future__ import annotations

import logging
import os
import socket
import threading
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any
from uuid import UUID, uuid4

import psycopg
from psycopg.rows import dict_row
from pydantic import BaseModel, ValidationError

from .contract import Agent, AgentResult, AgentSpec, RunContext
from .llm import LLMGateway, NullGateway
from .registry import AgentRegistry
from .storage import BlobStorage
from .store import JobFiles, save_results

log = logging.getLogger("taxops.worker")


@dataclass(frozen=True)
class Job:
    id: UUID
    tenant_id: UUID
    type: str
    payload: dict[str, Any]
    attempts: int


OutputHandler = Callable[[Job, AgentSpec, BaseModel], None]


def _log_output(job: Job, spec: AgentSpec, output: BaseModel) -> None:
    # Phase 3 replaces this with persisting proposals for human review.
    log.info("agent=%s job=%s produced %s", spec.name, job.id, type(output).__name__)


class Worker:
    def __init__(
        self,
        conninfo: str,
        registry: AgentRegistry,
        gateway: LLMGateway,
        *,
        worker_id: str | None = None,
        on_output: OutputHandler = _log_output,
        lease_seconds: int = 600,
        retry_seconds: int = 30,
        batch_size: int = 5,
        storage: BlobStorage | None = None,
    ) -> None:
        self.conninfo = conninfo
        self.registry = registry
        self.gateway = gateway
        self.worker_id = worker_id or f"{socket.gethostname()}-{os.getpid()}-{uuid4().hex[:6]}"
        self.on_output = on_output
        self.lease_seconds = lease_seconds
        self.retry_seconds = retry_seconds
        self.batch_size = batch_size
        self.storage = storage

    # -- queue primitives -------------------------------------------------------------------------------
    def claim(self, conn: psycopg.Connection) -> list[Job]:
        events = self.registry.events()
        if not events:
            return []
        rows = conn.execute(
            "select id, tenant_id, type, payload, attempts from jobs_claim(%s, %s, %s, %s)",
            (self.worker_id, events, self.batch_size, self.lease_seconds),
        ).fetchall()
        return [Job(r["id"], r["tenant_id"], r["type"], r["payload"], r["attempts"]) for r in rows]

    def _complete(self, conn: psycopg.Connection, job: Job) -> None:
        conn.execute("select jobs_complete(%s, %s)", (job.id, self.worker_id))

    def _fail(self, conn: psycopg.Connection, job: Job, reason: str) -> None:
        conn.execute("select jobs_fail(%s, %s, %s, %s)", (job.id, self.worker_id, reason, self.retry_seconds))

    # -- processing ----------------------------------------------------------------------------------
    def process(self, conn: psycopg.Connection, job: Job) -> bool:
        """Runs every agent registered for the job's event. Returns True if the job succeeded."""
        agents = self.registry.for_event(job.type)
        try:
            files = JobFiles(conn, job.id, self.worker_id, self.storage) if self.storage and "fileId" in job.payload else None
            for agent_cls in agents:
                self._run_agent(conn, agent_cls, job, files)
        except ValidationError:
            self._fail(conn, job, "ValidationError: payload does not match the event contract")
            return False
        except Exception as e:
            log.exception("agent failed for job %s", job.id)
            self._fail(conn, job, f"{type(e).__name__}: agent run failed")
            return False
        self._complete(conn, job)
        return True

    def _run_agent(self, conn: psycopg.Connection, agent_cls: type[Agent], job: Job, files: JobFiles | None) -> None:
        payload = agent_cls.input_model.model_validate(job.payload)
        meta = files.meta() if files else None
        # Content only reaches an external model if the TENANT has opted in; otherwise the agent gets a gateway that refuses.
        allow = bool(meta and meta.external_llm_enabled)
        llm = self.gateway if allow or files is None else NullGateway("This tenant has not allowed external LLM processing.")
        ctx = RunContext(tenant_id=job.tenant_id, run_id=uuid4(), triggered_by_event=job.type, llm=llm, files=files, allow_external_llm=allow or files is None)
        output = agent_cls().run(ctx, payload)
        if isinstance(output, AgentResult) and files is not None:
            save_results(conn, job.id, self.worker_id, agent_cls.spec, output)  # atomic + idempotent per (job, agent)
        self.on_output(job, agent_cls.spec, output)

    def run_once(self) -> int:
        """Claims and processes one batch. Returns how many jobs were handled (success or failure)."""
        with psycopg.connect(self.conninfo, autocommit=True, row_factory=dict_row) as conn:
            jobs = self.claim(conn)
            for job in jobs:
                self.process(conn, job)
            return len(jobs)

    def run_forever(self, stop: threading.Event, poll_seconds: float = 2.0) -> None:
        log.info("worker %s listening for %s", self.worker_id, self.registry.events())
        while not stop.is_set():
            try:
                handled = self.run_once()
            except psycopg.OperationalError:
                log.exception("database unavailable; retrying")
                handled = 0
            if handled == 0:
                stop.wait(poll_seconds)
