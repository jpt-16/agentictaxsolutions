"""Worker tests run against the real Postgres test database (created by the TypeScript test run).
They are skipped automatically when it is not reachable."""
from __future__ import annotations

import json
import os
import threading
from uuid import uuid4

import psycopg
import pytest
from pydantic import BaseModel

from taxops_agents.contract import Agent, AgentSpec, Proposal, RunContext
from taxops_agents.events import FileUploaded
from taxops_agents.llm import FakeGateway
from taxops_agents.registry import AgentRegistry
from taxops_agents.worker import Worker

WORKER_URL = os.environ.get("TEST_WORKER_DATABASE_URL", "postgres://taxops_worker:taxops_worker@localhost:5433/taxops_test")
OWNER_URL = os.environ.get("TEST_DATABASE_OWNER_URL", "postgres://taxops_owner:taxops_owner@localhost:5433/taxops_test")


def _db_ready() -> bool:
    try:
        with psycopg.connect(OWNER_URL, connect_timeout=2) as c:
            return c.execute("select to_regclass('public.jobs') is not null").fetchone()[0]
    except Exception:  # noqa: BLE001
        return False


pytestmark = pytest.mark.skipif(not _db_ready(), reason="test database not available")


class Out(BaseModel):
    proposals: list[Proposal]


def make_agent(name: str, event: str, behaviour):
    class _Agent(Agent[FileUploaded, Out]):
        spec = AgentSpec(name=name, version="1.0.0", description="t", triggers=(event,))
        input_model = FileUploaded
        output_model = Out

        def run(self, ctx: RunContext, payload: FileUploaded) -> Out:
            return behaviour(ctx, payload)

    return _Agent


def payload() -> dict:
    return {"fileId": str(uuid4()), "submissionId": str(uuid4()), "itemId": str(uuid4()), "requestId": str(uuid4()), "kind": "xlsx"}


@pytest.fixture()
def tenant():
    tid = uuid4()
    with psycopg.connect(OWNER_URL, autocommit=False) as c:
        c.execute("select set_config('app.tenant_id', %s, true)", (str(tid),))
        c.execute("insert into tenants (id, name, slug) values (%s, 'py test', %s)", (tid, f"py-{tid.hex[:8]}"))
        c.commit()
    return tid


def enqueue(tenant_id, event: str, data: dict, max_attempts: int = 5):
    with psycopg.connect(OWNER_URL, autocommit=False) as c:
        c.execute("select set_config('app.tenant_id', %s, true)", (str(tenant_id),))
        row = c.execute(
            "insert into jobs (tenant_id, type, payload, max_attempts) values (%s, %s, %s::jsonb, %s) returning id",
            (tenant_id, event, json.dumps(data), max_attempts),
        ).fetchone()
        c.commit()
        return row[0]


def status(job_id):
    with psycopg.connect(OWNER_URL) as c:
        return c.execute("select status, attempts, last_error from jobs where id = %s", (job_id,)).fetchone()


def event_name() -> str:
    return f"file.uploaded.{uuid4().hex[:8]}"  # unique per test so tests never consume each other's jobs


def test_routes_a_job_to_its_agent_with_tenant_context_and_completes(tenant):
    ev, seen = event_name(), []

    def behave(ctx, p):
        seen.append((ctx.tenant_id, p.kind, ctx.llm))
        return Out(proposals=[Proposal(kind="finding", title="Totals do not foot", confidence=0.9)])

    reg = AgentRegistry(); reg.register(make_agent("route_agent", ev, behave))
    outputs = []
    w = Worker(WORKER_URL, reg, FakeGateway(), on_output=lambda j, s, o: outputs.append((j.type, s.name, o)))
    job_id = enqueue(tenant, ev, payload())
    assert w.run_once() == 1
    assert seen[0][0] == tenant and seen[0][1] == "xlsx"
    assert outputs[0][1] == "route_agent" and outputs[0][2].proposals[0].title == "Totals do not foot"
    assert status(job_id)[0] == "succeeded"
    assert w.run_once() == 0


def test_ignores_events_no_agent_listens_to(tenant):
    reg = AgentRegistry(); reg.register(make_agent("ignore_agent", event_name(), lambda c, p: Out(proposals=[])))
    job_id = enqueue(tenant, f"other.{uuid4().hex[:6]}", payload())
    assert Worker(WORKER_URL, reg, FakeGateway()).run_once() == 0
    assert status(job_id)[0] == "queued"


def test_agent_errors_retry_then_dead_letter_without_leaking_details(tenant):
    ev = event_name()

    def boom(ctx, p):
        raise RuntimeError("secret cell value 123-45-6789 must not be stored")

    reg = AgentRegistry(); reg.register(make_agent("boom_agent", ev, boom))
    w = Worker(WORKER_URL, reg, FakeGateway(), retry_seconds=0)
    job_id = enqueue(tenant, ev, payload(), max_attempts=2)
    w.run_once()
    assert status(job_id)[0] == "queued"
    w.run_once()
    st = status(job_id)
    assert st[0] == "dead" and st[1] == 2
    assert "RuntimeError" in st[2] and "123-45-6789" not in st[2]


def test_rejects_payloads_that_do_not_match_the_event_contract(tenant):
    ev = event_name()
    reg = AgentRegistry(); reg.register(make_agent("contract_agent", ev, lambda c, p: Out(proposals=[])))
    job_id = enqueue(tenant, ev, {"fileId": "not-a-uuid", "kind": "exe"}, max_attempts=1)
    Worker(WORKER_URL, reg, FakeGateway(), retry_seconds=0).run_once()
    st = status(job_id)
    assert st[0] == "dead" and "ValidationError" in st[2]


def test_concurrent_workers_never_process_a_job_twice(tenant):
    ev, lock, handled = event_name(), threading.Lock(), []

    def behave(ctx, p):
        with lock:
            handled.append(p.fileId)
        return Out(proposals=[])

    reg = AgentRegistry(); reg.register(make_agent("race_agent", ev, behave))
    ids = [payload() for _ in range(12)]
    for d in ids:
        enqueue(tenant, ev, d)
    workers = [Worker(WORKER_URL, reg, FakeGateway(), batch_size=3) for _ in range(4)]
    threads = [threading.Thread(target=lambda w=w: [w.run_once() for _ in range(4)]) for w in workers]
    [t.start() for t in threads]; [t.join() for t in threads]
    assert len(handled) == 12 and len({str(h) for h in handled}) == 12


def test_run_forever_stops_cleanly(tenant):
    reg = AgentRegistry(); reg.register(make_agent("loop_agent", event_name(), lambda c, p: Out(proposals=[])))
    stop = threading.Event()
    t = threading.Thread(target=Worker(WORKER_URL, reg, FakeGateway()).run_forever, args=(stop, 0.05))
    t.start(); stop.set(); t.join(timeout=5)
    assert not t.is_alive()


def test_worker_role_has_no_table_access():
    with psycopg.connect(WORKER_URL) as c:
        for table in ("jobs", "files", "requests", "users"):
            with pytest.raises(psycopg.errors.InsufficientPrivilege):
                c.execute(f"select * from {table} limit 1")
            c.rollback()
