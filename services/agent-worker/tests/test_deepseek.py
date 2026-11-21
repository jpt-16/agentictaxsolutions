"""The DeepSeek gateway against a LOCAL fake server: request shape, redaction, validation, error hygiene, redirects, size caps."""
from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest
from helpers import FakeFiles, context, make_xlsx, payload
from pydantic import BaseModel

from taxops_agents.agents.extraction import ExtractionAgent
from taxops_agents.llm import DeepSeekGateway, LLMError, NullGateway, build_gateway


class Answer(BaseModel):
    ok: bool
    note: str = ""


class Server:
    def __init__(self, handler):
        self.requests: list[dict] = []
        outer = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a): pass

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                outer.requests.append({"path": self.path, "auth": self.headers.get("Authorization"), "body": body})
                handler(self)

        self.httpd = HTTPServer(("127.0.0.1", 0), H)
        self.url = f"http://127.0.0.1:{self.httpd.server_port}"
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

    def close(self): self.httpd.shutdown()


def reply(content, finish="stop", status=200, raw=None):
    def h(req):
        data = raw if raw is not None else json.dumps({"choices": [{"message": {"content": content}, "finish_reason": finish}]}).encode()
        req.send_response(status); req.send_header("Content-Type", "application/json"); req.send_header("Content-Length", str(len(data))); req.end_headers(); req.wfile.write(data)
    return h


@pytest.fixture
def serve():
    servers = []
    def make(handler):
        s = Server(handler); servers.append(s); return s
    yield make
    for s in servers: s.close()


def gw(server, **kw): return DeepSeekGateway(api_key="sk-test-key", model="the-model-id", base_url=server.url, **kw)


def test_a_valid_answer_is_parsed_and_the_request_is_well_formed_and_redacted(serve):
    s = serve(reply('{"ok": true, "note": "fine"}'))
    out = gw(s).generate_structured("Employee SSN 123-45-6789 asked about EIN 12-3456789", Answer, system="You are careful.")
    assert out == Answer(ok=True, note="fine")
    r = s.requests[0]
    assert r["path"] == "/chat/completions" and r["auth"] == "Bearer sk-test-key"
    b = r["body"]
    assert b["model"] == "the-model-id" and b["response_format"] == {"type": "json_object"} and b["stream"] is False and b["temperature"] == 0
    text = json.dumps(b["messages"])
    assert "123-45-6789" not in text and "12-3456789" not in text and "[REDACTED:SSN]" in text   # identifiers never leave the process
    assert "json" in text.lower() and '"ok"' in b["messages"][0]["content"]                         # JSON mode needs the word; the schema is in the prompt


def test_a_fenced_answer_is_tolerated_and_a_wrong_shape_is_refused_without_echoing_it(serve):
    assert gw(serve(reply('```json\n{"ok": false}\n```'))).generate_structured("p", Answer).ok is False
    with pytest.raises(LLMError) as e:
        gw(serve(reply('{"unexpected": "SECRET-MODEL-OUTPUT"}'))).generate_structured("p", Answer)
    assert "SECRET-MODEL-OUTPUT" not in str(e.value)
    with pytest.raises(LLMError, match="did not match"):
        gw(serve(reply("not json at all"))).generate_structured("p", Answer)


def test_http_errors_truncation_and_junk_responses_never_leak_anything(serve):
    for status in (401, 429, 500):
        s = serve(reply("x", status=status, raw=b'{"error": "echoing your prompt SECRET-PROMPT and key sk-test-key"}'))
        with pytest.raises(LLMError) as e:
            gw(s).generate_structured("SECRET-PROMPT", Answer)
        assert str(status) in str(e.value) and "SECRET-PROMPT" not in str(e.value) and "sk-test-key" not in str(e.value)
    with pytest.raises(LLMError, match="cut off"):
        gw(serve(reply('{"ok": tr', finish="length"))).generate_structured("p", Answer)
    with pytest.raises(LLMError, match="unexpected response"):
        gw(serve(reply("", raw=b'{"choices": []}'))).generate_structured("p", Answer)
    with pytest.raises(LLMError, match="too large"):
        gw(serve(reply("", raw=b"x" * 1_100_000))).generate_structured("p", Answer)


def test_a_redirect_is_never_followed_so_the_key_cannot_be_sent_elsewhere(serve):
    other = serve(reply('{"ok": true}'))
    def redirect(req):
        req.send_response(307); req.send_header("Location", other.url + "/steal"); req.send_header("Content-Length", "0"); req.end_headers()
    s = serve(redirect)
    with pytest.raises(LLMError, match="307"):
        gw(s).generate_structured("p", Answer)
    assert other.requests == []


def test_configuration_is_strict(monkeypatch):
    monkeypatch.delenv("DEEPSEEK_API_KEY", raising=False)
    with pytest.raises(LLMError, match="DEEPSEEK_API_KEY"):
        DeepSeekGateway(model="m")
    with pytest.raises(LLMError, match="DEEPSEEK_MODEL"):
        DeepSeekGateway(api_key="k", model="")
    for bad in ("http://api.deepseek.com", "ftp://x", "http://evil.example", "http://127.0.0.1.evil.example"):
        with pytest.raises(LLMError, match="https"):
            DeepSeekGateway(api_key="k", model="m", base_url=bad)
    DeepSeekGateway(api_key="k", model="m", base_url="https://api.deepseek.com")
    DeepSeekGateway(api_key="k", model="m", base_url="http://localhost:9999")


def test_build_gateway_degrades_to_the_plain_code_path_when_unconfigured(monkeypatch):
    monkeypatch.delenv("DEEPSEEK_API_KEY", raising=False); monkeypatch.delenv("DEEPSEEK_MODEL", raising=False)
    assert isinstance(build_gateway("deepseek", optional=True), NullGateway)
    monkeypatch.setenv("DEEPSEEK_API_KEY", "k")
    assert "DEEPSEEK_MODEL" in build_gateway("deepseek", optional=True).reason
    monkeypatch.setenv("DEEPSEEK_MODEL", "m")
    g = build_gateway("deepseek", optional=True)
    assert isinstance(g, DeepSeekGateway) and g.model == "m"


def test_the_extraction_agent_works_end_to_end_with_this_provider_and_still_verifies_its_answer(serve):
    rows = [["Posn", "Bezeichnung X", "Plus", "Minus"], ["1000", "Cash", 100, 0], ["2000", "Payable", 0, 100], ["3000", "Capital", 5, 5], ["4000", "Sales", 0, 5], ["5000", "Costs", 5, 0]]
    good = {"is_trial_balance": True, "header_row": 1, "account_code_col": "A", "account_name_col": "B", "debit_col": "C", "credit_col": "D"}
    s = serve(reply(json.dumps(good)))
    files = FakeFiles(make_xlsx({"S": rows}))
    ctx, _ = context(files, gateway=gw(s), allow_llm=True)
    res = ExtractionAgent().run(ctx, payload(files))
    p = res.proposals[0]
    assert p.payload["method"] == "llm" and res.meta.llm_calls == 1 and res.meta.model == "the-model-id" and p.payload["stats"]["row_count"] == 5
    # a hallucinated column is discarded by verification, not trusted
    bad = dict(good, debit_col="Z", credit_col="Y")
    files2 = FakeFiles(make_xlsx({"S": rows}))
    ctx2, _ = context(files2, gateway=gw(serve(reply(json.dumps(bad)))), allow_llm=True)
    res2 = ExtractionAgent().run(ctx2, payload(files2))
    assert not res2.proposals or res2.proposals[0].payload["method"] != "llm"


def test_when_the_model_cannot_help_the_run_says_why_even_for_text_formatted_amounts():
    """Amounts stored as text (common outside the US) must not hide the reason the model was unavailable."""
    rows = [["Posn", "Bezeichnung X", "Plus", "Minus"], ["1000", "Kasse", "412.350,75", ""], ["2000", "Bank", "", "400.000,00"], ["3000", "Kapital", "", "12.350,75"], ["4000", "Umsatz", "", "5,00"], ["5000", "Kosten", "5,00", ""]]
    from taxops_agents.llm import NullGateway
    for gateway, expected in ((NullGateway("This tenant has not allowed external LLM processing."), "not allowed external LLM"), (None, "DeepSeek request failed (HTTP 401)")):
        files = FakeFiles(make_xlsx({"S": rows}))
        if gateway is None:
            srv = Server(reply("x", status=401, raw=b"{}")); gateway = gw(srv)
        ctx, _ = context(files, gateway=gateway, allow_llm=True)
        res = ExtractionAgent().run(ctx, payload(files))
        assert res.proposals == [] and "Why the AI model did not help" in res.meta.detail and expected in res.meta.detail, res.meta.detail
