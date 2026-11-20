import json
import logging

from taxops_agents.logging_setup import JsonFormatter


def render(**extra) -> dict:
    rec = logging.LogRecord("taxops.worker", logging.INFO, __file__, 1, "agent produced output", (), None)
    for k, v in extra.items():
        setattr(rec, k, v)
    return json.loads(JsonFormatter().format(rec))


def test_one_parseable_line_with_job_context():
    out = render(job_id="j1", tenant_id="t1", agent="extraction")
    assert out["level"] == "info" and out["msg"] == "agent produced output" and out["job_id"] == "j1" and out["agent"] == "extraction"
    assert out["ts"].endswith("+00:00")


def test_exceptions_log_the_type_only_never_the_message_or_trace():
    try:
        raise ValueError("cell value 123-45-6789 must not be logged")
    except ValueError:
        import sys

        rec = logging.LogRecord("x", logging.ERROR, __file__, 1, "agent failed", (), sys.exc_info())
    line = JsonFormatter().format(rec)
    assert json.loads(line)["error_type"] == "ValueError"
    assert "123-45-6789" not in line and "Traceback" not in line


def test_unexpected_fields_are_not_copied_through():
    out = render(job_id="j", api_key="sk-live-abc", payload={"cell": "secret"})
    assert "api_key" not in out and "payload" not in out
