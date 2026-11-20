"""`python -m taxops_agents` starts the queue worker."""
from __future__ import annotations

import logging
import os
import signal
import threading

from .llm import build_gateway
from .registry import AgentRegistry
from .worker import Worker

# Phase 3 registers the extraction agent here; Phase 4 adds validation.
registry = AgentRegistry()


def main() -> None:
    logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"), format="%(asctime)s %(levelname)s %(name)s %(message)s")
    conninfo = os.environ.get("WORKER_DATABASE_URL")
    if not conninfo:
        raise SystemExit("WORKER_DATABASE_URL is required (the restricted taxops_worker role).")
    stop = threading.Event()
    for sig in (signal.SIGINT, signal.SIGTERM):
        signal.signal(sig, lambda *_: stop.set())
    Worker(conninfo, registry, build_gateway()).run_forever(stop)


if __name__ == "__main__":
    main()
