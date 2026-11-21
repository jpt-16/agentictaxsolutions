"""End-to-end through the real worker and real Postgres: queue -> job-scoped file access -> agent -> persisted proposals.
Skipped when the test database is unavailable."""
from __future__ import annotations

import hashlib
import json
import tempfile
from pathlib import Path
from uuid import uuid4

import psycopg
import pytest
from helpers import TB, make_xlsx
from psycopg.rows import dict_row
from test_worker import OWNER_URL, WORKER_URL, _db_ready

from taxops_agents.agents.extraction import ExtractionAgent
from taxops_agents.agents.extraction.mapping import LLMMapping
from taxops_agents.llm import FakeGateway
from taxops_agents.registry import AgentRegistry
from taxops_agents.storage import LocalBlobStorage
from taxops_agents.worker import Worker

pytestmark = pytest.mark.skipif(not _db_ready(), reason="test database not available")


class Env:
    """A tenant with one request/item/submission, plus helpers to add files and jobs."""

    def __init__(self, ai: bool = True, ext: bool = False) -> None:
        self.tenant, self.user = uuid4(), uuid4()
        self.root = Path(tempfile.mkdtemp(prefix="taxops-agent-"))
        self.storage = LocalBlobStorage(self.root)
        self.request, self.item, self.sub = uuid4(), uuid4(), uuid4()
        with psycopg.connect(OWNER_URL) as c:
            c.execute("select set_config('app.tenant_id', %s, true)", (str(self.tenant),))
            c.execute("insert into tenants (id, name, slug, ai_extraction_enabled, external_llm_enabled) values (%s, 'agent test', %s, %s, %s)",
                      (self.tenant, f"ag-{self.tenant.hex[:8]}", ai, ext))
            c.execute("insert into users (id, tenant_id, email, name, role) values (%s, %s, %s, 'Pat', 'contributor')", (self.user, self.tenant, f"p-{self.user.hex[:8]}@x.test"))
            c.execute("insert into requests (id, tenant_id, reference, title, tax_year, due_date, status, created_by) values (%s, %s, %s, 'req', 2025, '2026-12-31', 'open', %s)",
                      (self.request, self.tenant, f"E-{self.request.hex[:6]}", self.user))
            c.execute("insert into request_items (id, tenant_id, request_id, position, title, data_type) values (%s, %s, %s, 1, 'TB', 'trial_balance')", (self.item, self.tenant, self.request))
            c.execute("insert into submissions (id, tenant_id, item_id, version, submitted_by, note) values (%s, %s, %s, 1, %s, 'n')", (self.sub, self.tenant, self.item, self.user))
            c.commit()

    def add_file(self, data: bytes, name: str = "tb.xlsx", sha: str | None = None) -> str:
        fid = uuid4()
        key = f"{self.tenant}/{fid}"
        (self.root / str(self.tenant)).mkdir(parents=True, exist_ok=True)
        (self.root / key).write_bytes(data)
        with psycopg.connect(OWNER_URL) as c:
            c.execute("select set_config('app.tenant_id', %s, true)", (str(self.tenant),))
            c.execute("insert into files (id, tenant_id, submission_id, original_name, content_type, size_bytes, sha256, storage_key, scanner, scanned_at, uploaded_by) "
                      "values (%s, %s, %s, %s, 'application/octet-stream', %s, %s, %s, 't', now(), %s)",
                      (fid, self.tenant, self.sub, name, len(data), sha or hashlib.sha256(data).hexdigest(), key, self.user))
            c.commit()
        return str(fid)

    def enqueue(self, file_id: str, event: str = "file.uploaded", tenant=None) -> str:
        tenant = tenant or self.tenant
        payload = {"fileId": file_id, "submissionId": str(self.sub), "itemId": str(self.item), "requestId": str(self.request), "kind": "xlsx"}
        with psycopg.connect(OWNER_URL) as c:
            c.execute("select set_config('app.tenant_id', %s, true)", (str(tenant),))
            row = c.execute("insert into jobs (tenant_id, type, payload, max_attempts) values (%s, %s, %s::jsonb, 2) returning id", (tenant, event, json.dumps(payload))).fetchone()
            c.commit()
            return str(row[0])

    def q(self, sql: str, *args):
        with psycopg.connect(OWNER_URL, row_factory=dict_row) as c:
            c.execute("select set_config('app.tenant_id', %s, true)", (str(self.tenant),))
            return c.execute(sql, args).fetchall()


def worker(env: Env, gateway=None, event="file.uploaded") -> Worker:
    reg = AgentRegistry()
    agent = type("TestExtraction", (ExtractionAgent,), {"spec": ExtractionAgent.spec.model_copy(update={"triggers": (event,)})})
    reg.register(agent)
    return Worker(WORKER_URL, reg, gateway or FakeGateway(), storage=env.storage, retry_seconds=0)


def test_end_to_end_proposals_rows_run_and_agent_audit_are_persisted():
    env = Env()
    ev = f"file.uploaded.{uuid4().hex[:6]}"
    fid = env.add_file(make_xlsx({"NWU – GBP": TB, "NWI – EUR": TB}))
    job = env.enqueue(fid, ev)
    assert worker(env, event=ev).run_once() == 1

    assert env.q("select status from jobs where id = %s", job)[0]["status"] == "succeeded"
    props = env.q("select * from proposals where file_id = %s order by title", fid)
    assert [p["title"] for p in props] == ["Trial balance – NWI – EUR", "Trial balance – NWU – GBP"]
    assert all(p["status"] == "pending" and p["request_id"] == env.request and p["item_id"] == env.item and float(p["confidence"]) >= 0.95 for p in props)
    rows = env.q("select * from extracted_rows where proposal_id = %s order by position", props[0]["id"])
    assert [r["source_row"] for r in rows] == [2, 3, 4, 5, 6, 7]
    assert rows[0]["values"]["debit"] == "1000" and rows[0]["cells"]["debit"] == "C2"
    run = env.q("select * from agent_runs where file_id = %s", fid)[0]
    assert run["status"] == "succeeded" and run["agent_version"] == "1.0.0" and run["llm_calls"] == 0
    audit = env.q("select action, actor_type, actor_label from audit_events where request_ref = %s order by seq", env.request)
    assert [a["action"] for a in audit] == ["proposal.created", "proposal.created", "agent.run_succeeded"]
    assert {a["actor_type"] for a in audit} == {"agent"} and "Extraction" in audit[0]["actor_label"]


def test_a_retried_save_does_not_duplicate_output():
    from taxops_agents.contract import AgentResult
    from taxops_agents.store import save_results

    env = Env()
    ev = f"file.uploaded.{uuid4().hex[:6]}"
    fid = env.add_file(make_xlsx({"TB": TB}))
    job = env.enqueue(fid, ev)
    w = worker(env, event=ev)
    with psycopg.connect(WORKER_URL, autocommit=True, row_factory=dict_row) as conn:
        (claimed,) = w.claim(conn)
        spec = ExtractionAgent.spec
        res: AgentResult = AgentResult(proposals=[], rows=[])
        first = save_results(conn, claimed.id, w.worker_id, spec, res)
        again = save_results(conn, claimed.id, w.worker_id, spec, res)
        assert first == again == []
    assert len(env.q("select 1 from agent_runs where job_id = %s", job)) == 1


def test_tenant_that_has_not_enabled_ai_gets_a_skipped_run_and_no_proposals():
    env = Env(ai=False)
    ev = f"file.uploaded.{uuid4().hex[:6]}"
    fid = env.add_file(make_xlsx({"TB": TB}))
    env.enqueue(fid, ev)
    worker(env, event=ev).run_once()
    assert env.q("select 1 from proposals where file_id = %s", fid) == []
    run = env.q("select status, detail from agent_runs where file_id = %s", fid)[0]
    assert run["status"] == "skipped" and "not enabled" in run["detail"]
    assert "agent.run_skipped" in [a["action"] for a in env.q("select action from audit_events where request_ref = %s", env.request)]


HARD = [["Ledger acct", "Text", "Amt DR (EUR)", "Amt CR (EUR)"], ["1000", "Cash", 100, 0], ["2000", "Payables", 0, 100]]


def test_external_llm_is_only_used_when_the_tenant_allows_it():
    answer = LLMMapping(is_trial_balance=True, header_row=1, account_code_col="A", account_name_col="B", debit_col="C", credit_col="D")
    for allowed in (False, True):
        env = Env(ext=allowed)
        ev = f"file.uploaded.{uuid4().hex[:6]}"
        fid = env.add_file(make_xlsx({"X": HARD}))
        env.enqueue(fid, ev)
        gw = FakeGateway([answer])
        worker(env, gw, ev).run_once()
        props = env.q("select payload from proposals where file_id = %s", fid)
        run = env.q("select llm_calls, prompt_version from agent_runs where file_id = %s", fid)[0]
        if allowed:
            assert len(gw.calls) == 1 and len(props) == 1 and props[0]["payload"]["method"] == "llm" and run["llm_calls"] == 1 and run["prompt_version"]
        else:
            assert gw.calls == [] and props == [] and run["llm_calls"] == 0


def test_a_tampered_stored_file_fails_the_job_and_produces_nothing():
    env = Env()
    ev = f"file.uploaded.{uuid4().hex[:6]}"
    fid = env.add_file(make_xlsx({"TB": TB}), sha="0" * 64)  # recorded hash does not match the bytes on disk
    job = env.enqueue(fid, ev)
    worker(env, event=ev).run_once()
    j = env.q("select status, last_error from jobs where id = %s", job)[0]
    assert j["status"] == "queued" and "StorageError" in j["last_error"]
    assert env.q("select 1 from proposals where file_id = %s", fid) == []


def test_a_job_cannot_be_pointed_at_another_tenants_file():
    mine, victim = Env(), Env()
    ev = f"file.uploaded.{uuid4().hex[:6]}"
    secret = victim.add_file(make_xlsx({"TB": TB}))
    job = mine.enqueue(secret, ev)  # my tenant's job, the victim's file id
    # the victim's bytes are not even reachable from my storage root; the DB also refuses to resolve the file
    worker(mine, event=ev).run_once()
    assert mine.q("select status from jobs where id = %s", job)[0]["status"] == "queued"  # failed -> retry, not success
    assert mine.q("select 1 from proposals") == [] and victim.q("select 1 from proposals") == []


def test_an_agent_failure_on_a_corrupt_workbook_is_recorded_once_and_not_retried():
    env = Env()
    ev = f"file.uploaded.{uuid4().hex[:6]}"
    fid = env.add_file(b"definitely not a workbook")
    job = env.enqueue(fid, ev)
    worker(env, event=ev).run_once()
    assert env.q("select status from jobs where id = %s", job)[0]["status"] == "succeeded"
    run = env.q("select status, detail from agent_runs where file_id = %s", fid)[0]
    assert run["status"] == "failed" and "not a valid" in run["detail"]


# ---------------------------------------------------------------------------------------- validation, end to end
APP_URL = "postgres://taxops_app:taxops_app@localhost:5433/taxops_test"
UNBALANCED = [["Account", "Description", "Debit", "Credit"], ["1000", "Cash", 100, 0], ["2000", "Payables", 0, 60], ["3000", "Capital", 0, 40],
              ["4000", "Revenue", 0, 45], ["5000", "Costs", 70, 0]]  # debits 170, credits 145: difference 25


def vworker(env: Env, event: str, gateway=None) -> Worker:
    from taxops_agents.agents.validation import ValidationAgent

    reg = AgentRegistry()
    reg.register(type("TestValidation", (ValidationAgent,), {"spec": ValidationAgent.spec.model_copy(update={"triggers": (event,)})}))
    return Worker(WORKER_URL, reg, gateway or FakeGateway(), storage=env.storage, retry_seconds=0)


def extract(env: Env, data: bytes) -> tuple[str, str]:
    """Runs the real extraction through the worker; returns (file id, proposal id)."""
    ev = f"file.uploaded.{uuid4().hex[:6]}"
    fid = env.add_file(data)
    env.enqueue(fid, ev)
    worker(env, event=ev).run_once()
    return fid, str(env.q("select id from proposals where file_id = %s", fid)[0]["id"])


def accept(env: Env, proposal_id: str) -> None:
    """A person accepts the proposal, through the restricted application role (the only role that may decide)."""
    with psycopg.connect(APP_URL) as c:
        c.execute("select set_config('app.tenant_id', %s, true)", (str(env.tenant),))
        c.execute("select set_config('app.user_id', %s, true)", (str(env.user),))
        c.execute("update proposals set status = 'accepted', decided_by = %s, decided_at = now() where id = %s", (env.user, proposal_id))
        c.commit()


def enqueue_validation(env: Env, fid: str, pid: str, event: str) -> str:
    payload = {"proposalId": pid, "fileId": fid, "requestId": str(env.request), "itemId": str(env.item), "schema": "trial_balance"}
    with psycopg.connect(OWNER_URL) as c:
        c.execute("select set_config('app.tenant_id', %s, true)", (str(env.tenant),))
        row = c.execute("insert into jobs (tenant_id, type, payload, max_attempts) values (%s, %s, %s::jsonb, 2) returning id", (env.tenant, event, json.dumps(payload))).fetchone()
        c.commit()
        return str(row[0])


def test_accepted_extraction_is_validated_and_findings_are_persisted_for_review():
    env = Env()
    fid, pid = extract(env, make_xlsx({"S": UNBALANCED}))
    accept(env, pid)
    ev = f"proposal.accepted.{uuid4().hex[:6]}"
    job = enqueue_validation(env, fid, pid, ev)
    assert vworker(env, ev).run_once() == 1
    assert env.q("select status from jobs where id = %s", job)[0]["status"] == "succeeded"

    findings = env.q("select * from proposals where kind = 'finding' and source_proposal_id = %s", pid)
    foot = next(f for f in findings if f["rule_id"] == "tb_footing")
    assert foot["status"] == "pending" and foot["severity"] == "error" and float(foot["confidence"]) == 1.0
    assert foot["payload"]["metrics"]["difference"] == "25" and foot["file_id"] == uuid_of(fid) and foot["request_id"] == env.request
    run = env.q("select status, agent_name, detail from agent_runs where file_id = %s and agent_name = 'validation'", fid)[0]
    assert run["status"] == "succeeded" and "error" in run["detail"]
    audit = env.q("select action, actor_type from audit_events where entity_id = %s", foot["id"])
    assert audit == [{"action": "proposal.created", "actor_type": "agent"}]


def uuid_of(s: str):
    from uuid import UUID

    return UUID(s)


def test_validation_only_runs_against_accepted_extractions():
    env = Env()
    fid, pid = extract(env, make_xlsx({"S": UNBALANCED}))  # still PENDING review
    ev = f"proposal.accepted.{uuid4().hex[:6]}"
    enqueue_validation(env, fid, pid, ev)
    vworker(env, ev).run_once()
    assert env.q("select 1 from proposals where kind = 'finding'") == []
    run = env.q("select status, detail from agent_runs where agent_name = 'validation' and file_id = %s", fid)[0]
    assert run["status"] == "skipped" and "No accepted extraction" in run["detail"]


def test_a_balanced_trial_balance_validates_clean():
    env = Env()
    fid, pid = extract(env, make_xlsx({"S": [UNBALANCED[0], ["1000", "Cash", 100, 0], ["2000", "Payables", 0, 60], ["3000", "Capital", 0, 40], ["4000", "Revenue", 0, 45], ["5000", "Costs", 45, 0]]}))
    accept(env, pid)
    ev = f"proposal.accepted.{uuid4().hex[:6]}"
    enqueue_validation(env, fid, pid, ev)
    vworker(env, ev).run_once()
    assert [f["rule_id"] for f in env.q("select rule_id from proposals where kind = 'finding'")] == []
    assert "no findings" in env.q("select detail from agent_runs where agent_name = 'validation' and file_id = %s", fid)[0]["detail"]


def test_a_reviewer_remap_supersedes_the_pending_proposal_for_that_sheet():
    from taxops_agents.agents.extraction import RemapAgent

    env = Env()
    fid, old = extract(env, make_xlsx({"S": UNBALANCED}))
    ev = f"extraction.remap.{uuid4().hex[:6]}"
    reg = AgentRegistry()
    reg.register(type("TestRemap", (RemapAgent,), {"spec": RemapAgent.spec.model_copy(update={"triggers": (ev,)})}))
    payload = {"fileId": fid, "submissionId": str(env.sub), "itemId": str(env.item), "requestId": str(env.request), "kind": "xlsx", "sheet": "S",
               "headerRow": 1, "columns": {"account_code": "A", "account_name": "B", "debit": "C", "credit": "D"}, "requestedBy": str(env.user)}
    with psycopg.connect(OWNER_URL) as c:
        c.execute("select set_config('app.tenant_id', %s, true)", (str(env.tenant),))
        c.execute("insert into jobs (tenant_id, type, payload, max_attempts) values (%s, %s, %s::jsonb, 2)", (env.tenant, ev, json.dumps(payload)))
        c.commit()
    Worker(WORKER_URL, reg, FakeGateway(), storage=env.storage, retry_seconds=0).run_once()
    rows = {r["id"]: r for r in env.q("select id, status, payload from proposals where file_id = %s", fid)}
    assert rows[uuid_of(old)]["status"] == "superseded"
    new = next(r for r in rows.values() if r["status"] == "pending")
    assert new["payload"]["method"] == "manual" and new["payload"]["stats"]["row_count"] == 5


# ---------------------------------------------------------------------------------------------- spending limits through the real worker
def _odd_file(n: int) -> bytes:
    rows = [["Posn", "Bezeichnung X", "Plus", "Minus"], [f"{n}000", "Kasse", 5, 0], ["2000", "Bank", 0, 5], ["3000", "Kapital", 0, 0], ["4000", "Umsatz", 0, 0], ["5000", "Kosten", 0, 0]]
    return make_xlsx({"S": rows})


def test_the_companys_daily_call_limit_stops_external_calls_for_later_files(monkeypatch):
    """Limit 2. Four files that all need the model; the provider answers garbage (so no useful result, but it still bills)."""
    monkeypatch.setenv("LLM_MAX_CALLS_PER_JOB", "5")
    env = Env(ai=True, ext=True)
    with psycopg.connect(OWNER_URL) as c:
        c.execute("select set_config('app.tenant_id', %s, true)", (str(env.tenant),))
        c.execute("update tenants set llm_daily_call_limit = 2")
        c.commit()
    gw = FakeGateway()                                   # no queued responses: every call raises, and every call is an attempt
    jobs = [env.enqueue(env.add_file(_odd_file(i), f"f{i}.xlsx")) for i in range(1, 5)]
    w = worker(env, gw)
    while w.run_once():
        pass
    runs = env.q("select llm_calls, detail from agent_runs order by created_at")
    assert [r["llm_calls"] for r in runs] == [1, 1, 0, 0]                            # attempts count even though every answer failed
    assert all("daily limit of 2 external AI calls has been reached" in r["detail"] for r in runs[2:])
    assert len(gw.calls) == 2 and len(jobs) == 4                                     # the provider was contacted exactly twice


def test_a_limit_of_zero_means_no_external_call_is_ever_made(monkeypatch):
    env = Env(ai=True, ext=True)
    with psycopg.connect(OWNER_URL) as c:
        c.execute("select set_config('app.tenant_id', %s, true)", (str(env.tenant),))
        c.execute("update tenants set llm_daily_call_limit = 0")
        c.commit()
    gw = FakeGateway([LLMMapping(is_trial_balance=True, header_row=1, account_code_col="A", account_name_col="B", debit_col="C", credit_col="D")])
    env.enqueue(env.add_file(_odd_file(1)))
    w = worker(env, gw)
    while w.run_once():
        pass
    assert gw.calls == [] and env.q("select llm_calls, detail from agent_runs")[0]["llm_calls"] == 0
    assert "limit of 0" in env.q("select detail from agent_runs")[0]["detail"]


def test_the_per_file_cap_bounds_calls_within_one_workbook(monkeypatch):
    monkeypatch.setenv("LLM_MAX_CALLS_PER_JOB", "2")
    env = Env(ai=True, ext=True)
    odd = [["Posn", "Bezeichnung X", "Plus", "Minus"], ["1000", "Kasse", 5, 0], ["2000", "Bank", 0, 5], ["3000", "Kapital", 0, 0], ["4000", "Umsatz", 0, 0], ["5000", "Kosten", 0, 0]]
    answer = LLMMapping(is_trial_balance=True, header_row=1, account_code_col="A", account_name_col="B", debit_col="C", credit_col="D")
    gw = FakeGateway([answer] * 20)
    env.enqueue(env.add_file(make_xlsx({f"S{i}": odd for i in range(20)})))
    w = worker(env, gw)
    while w.run_once():
        pass
    assert len(gw.calls) == 2 and env.q("select llm_calls from agent_runs")[0]["llm_calls"] == 2    # 18 sheets never reached the provider
