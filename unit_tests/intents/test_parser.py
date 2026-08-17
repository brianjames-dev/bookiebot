import asyncio
import json

import pytest

from bookiebot.intents.parser import IntentParserError, parse_message_llm
from bookiebot.intents.explorer import INTENTS
from bookiebot.llm.client import FixtureLLMClient, LLMClient


def test_parse_message_llm_uses_fixture_payload():
    payload = {"intent": "log_expense", "entities": {"amount": 42.0}}
    client = FixtureLLMClient(payload)

    result = asyncio.run(parse_message_llm("anything", llm_client=client))

    assert result == payload
    assert result is not payload  # defensive copy


class _StringLLMClient(LLMClient):
    async def complete(self, *, messages, temperature=0.0, **kwargs):
        return json.dumps({"intent": "fallback", "entities": {}})


def test_parse_message_llm_handles_json_strings():
    client = _StringLLMClient()

    result = asyncio.run(parse_message_llm("anything", llm_client=client))

    assert result["intent"] == "fallback"


class _CapturingLLMClient(LLMClient):
    def __init__(self):
        self.messages = []
        self.kwargs = {}

    async def complete(self, *, messages, temperature=0.0, **kwargs):
        self.messages = messages
        self.kwargs = kwargs
        return {"intent": "log_need_expense", "entities": {"item": "copay", "location": "Kaiser", "amount": 40}}


def test_need_expense_prompt_uses_shared_expense_fields():
    client = _CapturingLLMClient()

    result = asyncio.run(parse_message_llm("Need expense $40 copay at Kaiser", llm_client=client))

    prompt = client.messages[0]["content"]
    assert result["entities"] == {"item": "copay", "location": "Kaiser", "amount": 40}
    assert "same separated expense fields as other shared expenses" in prompt
    assert "handler routes it to the shared Needs category and timestamps it" in prompt
    assert "only include the description of the expense and the amount" not in prompt
    assert client.kwargs["response_format"] == {"type": "json_object"}


def test_student_loan_payment_intents_are_retired_from_parser_prompt():
    client = _CapturingLLMClient()

    asyncio.run(parse_message_llm("Did the student loan autopay?", llm_client=client))

    prompt = client.messages[0]["content"]
    assert "log_student_loan_paid" not in INTENTS
    assert "query_student_loans_paid" not in INTENTS
    assert "log_student_loan_paid" not in prompt
    assert "query_student_loans_paid" not in prompt
    assert "tracked as subscription autopay" in prompt
    assert "return the fallback intent" in prompt


def test_parser_prompt_never_reinterprets_bank_transfer_instructions_as_savings_logs():
    client = _CapturingLLMClient()

    asyncio.run(
        parse_message_llm(
            "Please transfer $50 from checking to savings",
            llm_client=client,
        )
    )

    prompt = client.messages[0]["content"]
    assert "cannot move money between bank accounts" in prompt
    assert 'never reinterpret that instruction as "log_savings"' in prompt


class _FailingLLMClient(LLMClient):
    async def complete(self, *, messages, temperature=0.0, **kwargs):
        raise RuntimeError("OpenAI returned 500")


def test_parse_message_llm_does_not_turn_provider_errors_into_fallback():
    with pytest.raises(IntentParserError, match="temporarily unavailable"):
        asyncio.run(parse_message_llm("Water bill 148.82", llm_client=_FailingLLMClient()))


class _MalformedLLMClient(LLMClient):
    async def complete(self, *, messages, temperature=0.0, **kwargs):
        return "not json"


def test_parse_message_llm_rejects_malformed_provider_output():
    with pytest.raises(IntentParserError, match="invalid response"):
        asyncio.run(parse_message_llm("anything", llm_client=_MalformedLLMClient()))


def test_parse_message_llm_rejects_unknown_intents():
    client = FixtureLLMClient({"intent": "made_up_intent", "entities": {}})

    with pytest.raises(IntentParserError, match="invalid response"):
        asyncio.run(parse_message_llm("anything", llm_client=client))
