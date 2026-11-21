"""The worker's only access to platform data: two DB functions bound to the job it currently holds."""
from __future__ import annotations

from uuid import UUID

import psycopg
from psycopg.types.json import Jsonb

from .contract import AgentResult, AgentSpec, FileBlob, FileMeta, RelatedProposal, RelatedSet, SourceProposal
from .storage import BlobStorage, verify_sha256


class JobFiles:
    """FileAccess implementation: yields the one file the held job refers to, hash-verified."""

    def __init__(self, conn: psycopg.Connection, job_id: UUID, worker_id: str, storage: BlobStorage) -> None:
        self.conn, self.job_id, self.worker_id, self.storage = conn, job_id, worker_id, storage
        self._meta: FileMeta | None = None

    def meta(self) -> FileMeta | None:
        """File metadata + tenant governance flags for the held job (None if the job has no file)."""
        if self._meta is None:
            row = self.conn.execute("select * from agent_get_file(%s, %s)", (self.job_id, self.worker_id)).fetchone()
            if row is None:
                return None
            self._meta = FileMeta(**row)
        return self._meta

    def open(self, file_id: UUID) -> FileBlob:
        meta = self.meta()
        if meta is None or meta.file_id != file_id:
            raise PermissionError("This job may not open that file.")
        data = self.storage.get(meta.storage_key)
        verify_sha256(data, meta.sha256)
        return FileBlob(meta=meta, data=data)


class JobProposals:
    """ProposalAccess implementation: the one ACCEPTED extraction the held job refers to."""

    def __init__(self, conn: psycopg.Connection, job_id: UUID, worker_id: str) -> None:
        self.conn, self.job_id, self.worker_id = conn, job_id, worker_id
        self._data: dict | None | bool = False  # False = not loaded yet
        self.external_llm_enabled = False

    def _load(self) -> dict | None:
        if self._data is False:
            row = self.conn.execute("select agent_get_proposal(%s, %s) as d", (self.job_id, self.worker_id)).fetchone()
            self._data = row["d"] if row else None
            self.external_llm_enabled = bool(self._data and self._data["tenant"]["external_llm_enabled"])
        return self._data  # type: ignore[return-value]

    def external_allowed(self) -> bool:
        self._load()
        return self.external_llm_enabled

    def open(self, proposal_id: UUID) -> SourceProposal | None:
        d = self._load()
        if d is None or UUID(str(d["proposal"]["id"])) != proposal_id:
            return None
        return SourceProposal(
            id=proposal_id, schema_key=d["proposal"]["schema_key"], payload=d["proposal"]["payload"], rows=d["rows"],
            rule_settings={s["rule_id"]: {"enabled": s["enabled"], "params": s["params"]} for s in d["settings"]},
            external_llm_enabled=self.external_llm_enabled, request_reference=d["request"]["reference"], tax_year=d["request"]["tax_year"],
        )


    def related(self, proposal_id: UUID) -> RelatedSet | None:
        """Accepted trial balances and documents of the same request as the held job's proposal (one DB function, size-capped)."""
        row = self.conn.execute("select agent_get_related(%s, %s) as d", (self.job_id, self.worker_id)).fetchone()
        d = row["d"] if row else None
        if d is None or UUID(str(d["self"])) != proposal_id:
            return None
        return RelatedSet(
            self_id=proposal_id, request_reference=d["request"]["reference"], tax_year=d["request"]["tax_year"],
            rule_settings={x["rule_id"]: {"enabled": x["enabled"], "params": x["params"]} for x in d["settings"]},
            external_llm_enabled=bool(d["tenant"]["external_llm_enabled"]),
            proposals=[RelatedProposal(id=p["id"], schema_key=p["schema_key"], payload=p["payload"], file_name=p["file_name"], item_title=p["item_title"], rows=p["rows"]) for p in d["proposals"]],
        )


def save_results(conn: psycopg.Connection, job_id: UUID, worker_id: str, spec: AgentSpec, result: AgentResult) -> list[UUID]:
    """Persists an agent's output atomically. Idempotent per (job, agent): safe to retry."""
    run = result.meta.model_dump(mode="json")
    proposals = [
        {
            "kind": p.kind, "schema_key": p.payload.get("schema"), "title": p.title, "detail": p.detail,
            "payload": p.model_dump(mode="json")["payload"], "confidence": p.confidence, "severity": p.severity,
            "rule_id": p.rule_id, "source_proposal_id": str(p.source_proposal_id) if p.source_proposal_id else None,
        }
        for p in result.proposals
    ]
    rows = [r.model_dump(mode="json") for r in result.rows]
    out = conn.execute(
        "select agent_save_results(%s, %s, %s, %s, %s, %s, %s) as ids",
        (job_id, worker_id, spec.name, spec.version, Jsonb(run), Jsonb(proposals), Jsonb(rows)),
    ).fetchone()
    return list(out["ids"])
