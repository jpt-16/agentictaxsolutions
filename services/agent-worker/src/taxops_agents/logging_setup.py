"""Logging for the worker. LOG_FORMAT=json emits one machine-parseable line per event.

Exception tracebacks can contain cell values or model output, so JSON logs carry only the exception TYPE, never its message or trace.
"""
from __future__ import annotations

import json
import logging
import os
from datetime import UTC, datetime

_SENSITIVE = ("password", "secret", "token", "authorization", "api_key", "apikey", "cookie")
_EXTRA = ("job_id", "job_type", "tenant_id", "agent", "attempt", "worker_id")


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        out: dict[str, object] = {
            "ts": datetime.fromtimestamp(record.created, UTC).isoformat(timespec="milliseconds"),
            "level": record.levelname.lower(), "logger": record.name, "msg": record.getMessage(),
        }
        for k in _EXTRA:
            if hasattr(record, k):
                out[k] = str(getattr(record, k))
        if record.exc_info and record.exc_info[0] is not None:
            out["error_type"] = record.exc_info[0].__name__
        for k in list(out):
            if any(s in k.lower() for s in _SENSITIVE):
                out[k] = "[redacted]"
        return json.dumps(out, ensure_ascii=False)


def configure_logging() -> None:
    handler = logging.StreamHandler()
    if os.environ.get("LOG_FORMAT", "text").lower() == "json":
        handler.setFormatter(JsonFormatter())
    else:
        handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s %(message)s"))
    root = logging.getLogger()
    root.handlers[:] = [handler]
    root.setLevel(os.environ.get("LOG_LEVEL", "INFO").upper())
