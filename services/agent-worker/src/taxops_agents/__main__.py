"""`python -m taxops_agents` starts the queue worker."""
from __future__ import annotations

import argparse
import logging
import os
import signal
import threading

from .agents.extraction import ExtractionAgent, RemapAgent
from .agents.validation import ValidationAgent
from .llm import build_gateway
from .registry import AgentRegistry
from .storage import LocalBlobStorage, find_repo_root, resolve_storage_dir
from .worker import Worker


def _load_repo_env() -> None:
    """Dev convenience: read the repo-root .env for variables that are not already set (never overrides the real environment)."""
    path = find_repo_root() / ".env"
    if not path.exists():
        return
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


registry = AgentRegistry()
registry.register(ExtractionAgent)
registry.register(RemapAgent)
registry.register(ValidationAgent)


def main() -> None:
    parser = argparse.ArgumentParser(description="Tax Operations agent worker")
    parser.add_argument("--once", action="store_true", help="drain the queue, then exit")
    args = parser.parse_args()
    _load_repo_env()
    logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"), format="%(asctime)s %(levelname)s %(name)s %(message)s")
    conninfo = os.environ.get("WORKER_DATABASE_URL")
    if not conninfo:
        raise SystemExit("WORKER_DATABASE_URL is required (the restricted taxops_worker role).")
    worker = Worker(conninfo, registry, build_gateway(optional=True), storage=LocalBlobStorage(resolve_storage_dir()))
    if args.once:
        total = 0
        while (n := worker.run_once()) > 0:
            total += n
        logging.getLogger("taxops.worker").info("queue drained; handled %d job(s)", total)
        return
    stop = threading.Event()
    for sig in (signal.SIGINT, signal.SIGTERM):
        signal.signal(sig, lambda *_: stop.set())
    worker.run_forever(stop)


if __name__ == "__main__":
    main()
