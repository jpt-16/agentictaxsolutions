"""The worker's only access to platform data: two DB functions bound to the job it currently holds."""
from __future__ import annotations

from uuid import UUID

import psycopg
from psycopg.types.json import Jsonb

from .contract import AgentResult, AgentSpec, FileBlob, FileMeta
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


def save_results(conn: psycopg.Connection, job_id: UUID, worker_id: str, spec: AgentSpec, result: AgentResult) -> list[UUID]:
    """Persists an agent's output atomically. Idempotent per (job, agent): safe to retry."""
    run = result.meta.model_dump(mode="json")
    proposals = [
        {
            "kind": p.kind, "schema_key": p.payload.get("schema"), "title": p.title, "detail": p.detail,
            "payload": p.model_dump(mode="json")["payload"], "confidence": p.confidence, "severity": p.severity,
        }
        for p in result.proposals
    ]
    rows = [r.model_dump(mode="json") for r in result.rows]
    out = conn.execute(
        "select agent_save_results(%s, %s, %s, %s, %s, %s, %s) as ids",
        (job_id, worker_id, spec.name, spec.version, Jsonb(run), Jsonb(proposals), Jsonb(rows)),
    ).fetchone()
    return list(out["ids"])
