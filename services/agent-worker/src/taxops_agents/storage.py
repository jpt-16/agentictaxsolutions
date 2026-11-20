from __future__ import annotations

import hashlib
import os
import re
from pathlib import Path
from typing import Protocol

# Same strict pattern as the TypeScript side: `<tenant uuid>/<file uuid>`. Anything else is refused.
_KEY = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")


class StorageError(RuntimeError):
    pass


class BlobStorage(Protocol):
    def get(self, key: str) -> bytes: ...


def find_repo_root(start: Path | None = None) -> Path:
    here = (start or Path.cwd()).resolve()
    for d in (here, *here.parents):
        if (d / "pnpm-workspace.yaml").exists():
            return d
    return here


def resolve_storage_dir(env: dict[str, str] | None = None) -> Path:
    """Mirrors `resolveStorageDir` in the TypeScript app: relative paths resolve against the repo root."""
    env = os.environ if env is None else env
    configured = (env.get("STORAGE_DIR") or "").strip()
    if not configured:
        return find_repo_root() / ".storage"
    p = Path(configured)
    return p if p.is_absolute() else find_repo_root() / p


class LocalBlobStorage:
    def __init__(self, root: Path) -> None:
        self.root = root.resolve()

    def get(self, key: str) -> bytes:
        if not _KEY.match(key):
            raise StorageError("Invalid storage key.")
        full = (self.root / key).resolve()
        if self.root not in full.parents:
            raise StorageError("Invalid storage key.")
        try:
            return full.read_bytes()
        except FileNotFoundError:
            raise StorageError("Stored file is missing.") from None


def verify_sha256(data: bytes, expected: str) -> None:
    if hashlib.sha256(data).hexdigest() != expected:
        raise StorageError("Stored file failed its integrity check.")
