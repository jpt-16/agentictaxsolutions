"""Provider-agnostic LLM gateway.

Every model call in the platform goes through this interface, so we have ONE place to:
  * swap providers (Gemini and DeepSeek today; any other tomorrow) without touching agent code,
  * redact sensitive identifiers before they leave our boundary,
  * log metadata (model, tokens, latency) without logging tenant content,
  * enforce structured, schema-validated output.
"""
from __future__ import annotations

import json
import os
import re
import urllib.error
import urllib.request
from typing import Any, Protocol, TypeVar, runtime_checkable
from urllib.parse import urlparse

from pydantic import BaseModel

T = TypeVar("T", bound=BaseModel)


class LLMError(RuntimeError):
    pass


@runtime_checkable
class LLMGateway(Protocol):
    def generate_structured(self, prompt: str, schema: type[T], *, system: str | None = None) -> T: ...


# --- redaction -----------------------------------------------------------------------------------------

_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("SSN", re.compile(r"\b\d{3}-\d{2}-\d{4}\b")),
    ("EIN", re.compile(r"\b\d{2}-\d{7}\b")),
    ("IBAN", re.compile(r"\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b")),
    ("CARD", re.compile(r"\b(?:\d[ -]?){13,19}\b")),
    ("EMAIL", re.compile(r"\b[\w.+-]+@[\w-]+\.[\w.-]+\b")),
)


def redact(text: str) -> str:
    """Masks common sensitive identifiers. A safety net, not a substitute for sending minimal data."""
    for label, pattern in _PATTERNS:
        text = pattern.sub(f"[REDACTED:{label}]", text)
    return text


# --- implementations -----------------------------------------------------------------------------------


class GeminiGateway:
    """Gemini via the `google-genai` SDK (install with `pip install .[gemini]`).

    NOTE: not yet exercised against the live API in this repo; unit tests inject a stub client.
    Verify the model id and your data-retention terms before sending anything beyond fictional data.
    """

    def __init__(self, api_key: str | None = None, model: str | None = None, client: Any | None = None) -> None:
        self.model = model or os.environ.get("GEMINI_MODEL", "gemini-2.5-flash")
        if client is not None:
            self._client = client
            return
        key = api_key or os.environ.get("GEMINI_API_KEY")
        if not key:
            raise LLMError("GEMINI_API_KEY is not set.")
        try:
            from google import genai  # imported lazily so the package imports without the SDK
        except ImportError as e:  # pragma: no cover
            raise LLMError("Install the Gemini extra: pip install .[gemini]") from e
        self._client = genai.Client(api_key=key)

    def generate_structured(self, prompt: str, schema: type[T], *, system: str | None = None) -> T:
        config: dict[str, Any] = {"response_mime_type": "application/json", "response_schema": schema}
        if system:
            config["system_instruction"] = redact(system)
        try:
            response = self._client.models.generate_content(model=self.model, contents=redact(prompt), config=config)
        except Exception as e:  # noqa: BLE001 - deliberate: provider errors can embed prompt content
            raise LLMError(f"Gemini request failed ({type(e).__name__}).") from None
        parsed = getattr(response, "parsed", None)
        if isinstance(parsed, schema):
            return parsed
        try:
            return schema.model_validate_json(response.text)
        except Exception:  # noqa: BLE001 - deliberate: never echo model output into errors
            raise LLMError("Model output did not match the expected schema.") from None


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """Never follow a redirect: the API key must go to the configured host and nowhere else."""

    def redirect_request(self, *args: Any, **kwargs: Any) -> None:
        return None


class DeepSeekGateway:
    """DeepSeek's OpenAI-compatible chat API, using only the standard library (no SDK, no extra dependency).

    The model id is REQUIRED (DEEPSEEK_MODEL): copy it exactly from your DeepSeek account rather than trusting a default baked in here.
    Output is requested as a JSON object, the schema is given in the prompt, and the answer is validated with the same pydantic model
    the other gateways use, so an agent cannot tell which provider answered. Prompts are redacted before they leave the process, and
    errors never include the prompt, the model's output, the response body or the key.
    NOTE: not yet exercised against the live API in this repo; tests use a local fake server. Check your provider's data-retention
    and data-residency terms before sending anything beyond fictional data.
    """

    MAX_RESPONSE_BYTES = 1_000_000

    def __init__(self, api_key: str | None = None, model: str | None = None, base_url: str | None = None, timeout: float = 60.0) -> None:
        self.model = model or os.environ.get("DEEPSEEK_MODEL", "")
        key = api_key or os.environ.get("DEEPSEEK_API_KEY")
        if not key:
            raise LLMError("DEEPSEEK_API_KEY is not set.")
        if not self.model:
            raise LLMError("DEEPSEEK_MODEL is not set. Copy the exact model id from your DeepSeek account.")
        base = (base_url or os.environ.get("DEEPSEEK_BASE_URL") or "https://api.deepseek.com").rstrip("/")
        u = urlparse(base)
        if u.scheme != "https" and not (u.scheme == "http" and u.hostname in ("localhost", "127.0.0.1", "::1")):
            raise LLMError("DEEPSEEK_BASE_URL must use https.")
        self._key, self._base, self._timeout = key, base, timeout
        self._opener = urllib.request.build_opener(_NoRedirect)

    def generate_structured(self, prompt: str, schema: type[T], *, system: str | None = None) -> T:
        instructions = (system or "") + (
            "\n\nRespond with ONE JSON object that conforms to this JSON Schema, and nothing else (no prose, no code fences):\n"
            + json.dumps(schema.model_json_schema())
        )
        body = {
            "model": self.model, "stream": False, "temperature": 0, "max_tokens": 4096, "response_format": {"type": "json_object"},
            "messages": [{"role": "system", "content": redact(instructions)}, {"role": "user", "content": redact(prompt) + "\n\nReturn the answer as JSON."}],
        }
        req = urllib.request.Request(
            f"{self._base}/chat/completions", data=json.dumps(body).encode(), method="POST",
            headers={"Content-Type": "application/json", "Authorization": f"Bearer {self._key}", "Accept": "application/json"},
        )
        try:
            with self._opener.open(req, timeout=self._timeout) as resp:
                raw = resp.read(self.MAX_RESPONSE_BYTES + 1)
        except urllib.error.HTTPError as e:
            raise LLMError(f"DeepSeek request failed (HTTP {e.code}).") from None
        except Exception as e:  # noqa: BLE001 - deliberate: transport errors can embed URLs and headers
            raise LLMError(f"DeepSeek request failed ({type(e).__name__}).") from None
        if len(raw) > self.MAX_RESPONSE_BYTES:
            raise LLMError("DeepSeek response was too large.")
        try:
            choice = json.loads(raw)["choices"][0]
            if choice.get("finish_reason") == "length":
                raise LLMError("The model's answer was cut off.")
            text = str(choice["message"]["content"]).strip()
        except LLMError:
            raise
        except Exception:  # noqa: BLE001 - deliberate: never echo the response into errors
            raise LLMError("DeepSeek returned an unexpected response.") from None
        text = re.sub(r"^```(?:json)?\s*|\s*```$", "", text)  # tolerate a fenced answer
        try:
            return schema.model_validate_json(text)
        except Exception:  # noqa: BLE001 - deliberate: never echo model output into errors
            raise LLMError("Model output did not match the expected schema.") from None


class FakeGateway:
    """Deterministic gateway for tests and offline development. Returns queued responses in order."""

    def __init__(self, responses: list[BaseModel] | None = None) -> None:
        self._responses = list(responses or [])
        self.calls: list[str] = []

    def generate_structured(self, prompt: str, schema: type[T], *, system: str | None = None) -> T:
        self.calls.append(redact(prompt))
        if not self._responses:
            raise LLMError("FakeGateway has no queued response.")
        nxt = self._responses.pop(0)
        if not isinstance(nxt, schema):
            raise LLMError(f"Queued response is {type(nxt).__name__}, expected {schema.__name__}.")
        return nxt


class NullGateway:
    """Used when no model may be called (no API key, or the tenant has not allowed external LLM use)."""

    def __init__(self, reason: str = "External LLM calls are not available.") -> None:
        self.reason = reason

    def generate_structured(self, prompt: str, schema: type[T], *, system: str | None = None) -> T:
        raise LLMError(self.reason)


def build_gateway(provider: str | None = None, *, optional: bool = False) -> LLMGateway:
    """With optional=True a missing key yields a NullGateway, so agents degrade to their deterministic path."""
    provider = (provider or os.environ.get("LLM_PROVIDER", "gemini")).lower()
    if provider == "gemini":
        if optional and not os.environ.get("GEMINI_API_KEY"):
            return NullGateway("GEMINI_API_KEY is not set.")
        return GeminiGateway()
    if provider == "deepseek":
        if optional and not os.environ.get("DEEPSEEK_API_KEY"):
            return NullGateway("DEEPSEEK_API_KEY is not set.")
        if optional and not os.environ.get("DEEPSEEK_MODEL"):
            return NullGateway("DEEPSEEK_MODEL is not set.")
        return DeepSeekGateway()
    if provider == "fake":
        return FakeGateway()
    raise LLMError(f"Unknown LLM provider {provider!r}.")
