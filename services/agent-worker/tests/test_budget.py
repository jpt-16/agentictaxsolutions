"""Spending limits: no agent can make more model calls, or send bigger prompts, than the job is allowed."""
from __future__ import annotations

import pytest
from helpers import FakeFiles, context, make_xlsx, payload
from pydantic import BaseModel

from taxops_agents.agents.extraction import ExtractionAgent
from taxops_agents.agents.extraction.mapping import LLMMapping
from taxops_agents.llm import BudgetedGateway, FakeGateway, LLMError, NullGateway


class A(BaseModel):
    ok: bool = True


class Flaky:
    """A provider that is billed for every request but whose answer is unusable."""
    model = "m"
    def generate_structured(self, prompt, schema, *, system=None): raise LLMError("Model output did not match the expected schema.")


def test_calls_beyond_the_budget_are_refused_before_reaching_the_provider():
    inner = FakeGateway([A(), A(), A()])
    g = BudgetedGateway(inner, max_calls=2, reason="over budget")
    g.generate_structured("one", A); g.generate_structured("two", A)
    with pytest.raises(LLMError, match="over budget"):
        g.generate_structured("three", A)
    assert len(inner.calls) == 2 and g.attempts == 2            # the third never left the process


def test_every_attempt_counts_even_when_the_answer_is_rejected():
    g = BudgetedGateway(Flaky(), max_calls=3)
    for _ in range(3):
        with pytest.raises(LLMError, match="did not match"):
            g.generate_structured("x", A)
    assert g.attempts == 3                                       # the provider bills these, so they count
    with pytest.raises(LLMError, match="budget"):
        g.generate_structured("x", A)


def test_a_gateway_that_sends_nothing_is_never_counted():
    g = BudgetedGateway(NullGateway("not allowed"), max_calls=1)
    for _ in range(5):
        with pytest.raises(LLMError, match="not allowed"):
            g.generate_structured("x", A)
    assert g.attempts == 0


def test_one_oversized_prompt_is_refused_unsent_and_uncounted():
    inner = FakeGateway([A()])
    g = BudgetedGateway(inner, max_calls=5, max_prompt_chars=100)
    with pytest.raises(LLMError, match="larger than the allowed size"):
        g.generate_structured("x" * 90, A, system="y" * 20)
    assert inner.calls == [] and g.attempts == 0
    assert g.generate_structured("short", A).ok


def test_a_zero_budget_blocks_everything():
    with pytest.raises(LLMError):
        BudgetedGateway(FakeGateway([A()]), max_calls=0).generate_structured("x", A)


def test_a_workbook_with_many_unreadable_sheets_cannot_run_up_the_bill():
    """Fifty sheets that all need the model: the file's cap, not the file, decides how many calls are made."""
    odd = [["Posn", "Bezeichnung X", "Plus", "Minus"], ["1000", "Kasse", 5, 0], ["2000", "Bank", 0, 5], ["3000", "Kapital", 0, 0], ["4000", "Umsatz", 0, 0], ["5000", "Kosten", 0, 0]]
    sheets = {f"S{i}": odd for i in range(50)}
    answer = LLMMapping(is_trial_balance=True, header_row=1, account_code_col="A", account_name_col="B", debit_col="C", credit_col="D")
    inner = FakeGateway([answer] * 50)
    files = FakeFiles(make_xlsx(sheets))
    ctx, _ = context(files, gateway=BudgetedGateway(inner, max_calls=3, reason="file limit reached"), allow_llm=True)
    res = ExtractionAgent().run(ctx, payload(files))
    assert len(inner.calls) == 3                                  # 47 sheets were NOT sent to the provider
    assert len(res.proposals) == 3 and "file limit reached" in res.meta.detail
