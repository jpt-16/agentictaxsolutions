import pytest
from pydantic import ValidationError

from taxops_agents.events import EVENT_MODELS, FileUploaded

# Exact shape the TypeScript app enqueues (packages/services/src/requests.ts, submitItem).
WIRE = {
    "fileId": "6f1d3c1e-8d7a-4c53-9a43-0d6f7d2a9b10",
    "submissionId": "0b8f7f8e-3c1d-4f0a-8b5e-1a2b3c4d5e6f",
    "itemId": "11111111-2222-4333-8444-555555555555",
    "requestId": "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    "kind": "xlsx",
}


def test_wire_format_parses_and_is_registered():
    assert FileUploaded.model_validate(WIRE).kind == "xlsx"
    assert EVENT_MODELS["file.uploaded"] is FileUploaded


@pytest.mark.parametrize("bad", [{**WIRE, "kind": "exe"}, {**WIRE, "extra": 1}, {k: v for k, v in WIRE.items() if k != "itemId"}])
def test_rejects_malformed_payloads(bad):
    with pytest.raises(ValidationError):
        FileUploaded.model_validate(bad)
