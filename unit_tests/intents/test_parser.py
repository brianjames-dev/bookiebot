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
