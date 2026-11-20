from __future__ import annotations

from uuid import uuid4

import pytest
from pydantic import BaseModel, ValidationError

from taxops_agents.contract import Agent, AgentSpec, Proposal, RunContext
from taxops_agents.llm import FakeGateway, GeminiGateway, LLMError, build_gateway, redact
from taxops_agents.registry import AgentRegistry


class In(BaseModel):
    text: str


class Out(BaseModel):
    proposals: list[Proposal]


class Echo(Agent[In, Out]):
    spec = AgentSpec(name="echo_agent", version="1.0.0", description="test", triggers=("submission.uploaded",))
    input_model = In
    output_model = Out

    def run(self, ctx: RunContext, payload: In) -> Out:
        reply = ctx.llm.generate_structured(payload.text, Out)
        return reply


def ctx(llm) -> RunContext:
    return RunContext(tenant_id=uuid4(), run_id=uuid4(), triggered_by_event="submission.uploaded", llm=llm)


def test_registry_routes_events_and_rejects_duplicates():
    reg = AgentRegistry()
    reg.register(Echo)
    assert reg.for_event("submission.uploaded") == [Echo]
    assert reg.for_event("other.event") == []
    assert reg.names() == ["echo_agent"]
    with pytest.raises(ValueError):
        reg.register(Echo)
    with pytest.raises(KeyError):
        reg.get("nope")


def test_registry_requires_a_spec():
    class Bad(Agent[In, Out]):
        input_model = In
        output_model = Out

        def run(self, ctx, payload):  # pragma: no cover
            raise NotImplementedError

    with pytest.raises(TypeError):
        AgentRegistry().register(Bad)


def test_spec_validates_names_and_versions():
    with pytest.raises(ValidationError):
        AgentSpec(name="Bad Name", version="1.0.0", description="x", triggers=())
    with pytest.raises(ValidationError):
        AgentSpec(name="good_name", version="v1", description="x", triggers=())


def test_proposal_confidence_is_bounded():
    with pytest.raises(ValidationError):
        Proposal(kind="finding", title="x", confidence=1.5)


def test_agent_runs_with_a_fake_gateway_and_returns_proposals():
    expected = Out(proposals=[Proposal(kind="finding", title="Totals do not foot", confidence=0.9, severity="error")])
    out = Echo().run(ctx(FakeGateway([expected])), In(text="hello"))
    assert out.proposals[0].title == "Totals do not foot"


def test_redaction_masks_sensitive_identifiers_before_prompts_leave():
    raw = "SSN 123-45-6789, EIN 12-3456789, mail jane@corp.example, IBAN DE89370400440532013000"
    cleaned = redact(raw)
    for secret in ("123-45-6789", "12-3456789", "jane@corp.example", "DE89370400440532013000"):
        assert secret not in cleaned
    gw = FakeGateway([Out(proposals=[])])
    gw.generate_structured(raw, Out)
    assert "123-45-6789" not in gw.calls[0]


def test_fake_gateway_checks_types_and_exhaustion():
    gw = FakeGateway([In(text="x")])
    with pytest.raises(LLMError):
        gw.generate_structured("p", Out)
    with pytest.raises(LLMError):
        gw.generate_structured("p", Out)


class _Resp:
    def __init__(self, parsed=None, text=""):
        self.parsed, self.text = parsed, text


class _Models:
    def __init__(self, resp=None, boom=False):
        self.resp, self.boom, self.last = resp, boom, None

    def generate_content(self, **kw):
        self.last = kw
        if self.boom:
            raise RuntimeError("secret prompt content must not leak")
        return self.resp


class _Client:
    def __init__(self, models):
        self.models = models


def test_gemini_gateway_redacts_and_parses_with_an_injected_client():
    models = _Models(_Resp(parsed=Out(proposals=[])))
    gw = GeminiGateway(model="test-model", client=_Client(models))
    result = gw.generate_structured("ssn 123-45-6789", Out, system="be careful")
    assert result.proposals == []
    assert "123-45-6789" not in models.last["contents"]
    assert models.last["model"] == "test-model"
    assert models.last["config"]["response_schema"] is Out


def test_gemini_gateway_falls_back_to_json_text_and_hides_provider_errors():
    ok = GeminiGateway(client=_Client(_Models(_Resp(parsed=None, text='{"proposals": []}'))))
    assert ok.generate_structured("p", Out).proposals == []
    bad_json = GeminiGateway(client=_Client(_Models(_Resp(parsed=None, text="not json"))))
    with pytest.raises(LLMError):
        bad_json.generate_structured("p", Out)
    boom = GeminiGateway(client=_Client(_Models(boom=True)))
    with pytest.raises(LLMError) as err:
        boom.generate_structured("p", Out)
    assert "secret prompt content" not in str(err.value)


def test_build_gateway(monkeypatch):
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    with pytest.raises(LLMError):
        build_gateway("gemini")
    assert isinstance(build_gateway("fake"), FakeGateway)
    with pytest.raises(LLMError):
        build_gateway("nonsense")
