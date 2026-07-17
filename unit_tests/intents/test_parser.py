import asyncio
import json

from bookiebot.intents.parser import parse_message_llm
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

    async def complete(self, *, messages, temperature=0.0, **kwargs):
        self.messages = messages
        return {"intent": "log_need_expense", "entities": {"item": "copay", "location": "Kaiser", "amount": 40}}


def test_need_expense_prompt_uses_shared_expense_fields():
    client = _CapturingLLMClient()

    result = asyncio.run(parse_message_llm("Need expense $40 copay at Kaiser", llm_client=client))

    prompt = client.messages[0]["content"]
    assert result["entities"] == {"item": "copay", "location": "Kaiser", "amount": 40}
    assert "same separated expense fields as other shared expenses" in prompt
    assert "handler routes it to the shared Needs category and timestamps it" in prompt
    assert "only include the description of the expense and the amount" not in prompt
