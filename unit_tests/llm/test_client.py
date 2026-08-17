from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from bookiebot.llm.client import OpenAIClient


class _APIError(RuntimeError):
    def __init__(self, message: str, status: int, code: str | None = None):
        super().__init__(message)
        self.http_status = status
        self.code = code


def _client(fake_openai, *, attempts: int = 3) -> OpenAIClient:
    client = OpenAIClient.__new__(OpenAIClient)
    client._client = fake_openai
    client._model = "test-model"
    client._max_attempts = attempts
    client._base_retry_delay = 0.01
    client._max_retry_delay = 0.02
    return client


@pytest.mark.asyncio
async def test_openai_client_retries_transient_server_error(monkeypatch):
    calls = 0

    class Completions:
        @staticmethod
        def create(**kwargs):
            nonlocal calls
            calls += 1
            if calls == 1:
                raise _APIError("server error", 500)
            return SimpleNamespace(choices=[SimpleNamespace(message=SimpleNamespace(content='{"intent":"fallback","entities":{}}'))])

    sleep = AsyncMock()
    monkeypatch.setattr("bookiebot.llm.client.asyncio.sleep", sleep)
    client = _client(SimpleNamespace(chat=SimpleNamespace(completions=Completions)))

    result = await client.complete(messages=[{"role": "user", "content": "hi"}])

    assert result == '{"intent":"fallback","entities":{}}'
    assert calls == 2
    sleep.assert_awaited_once()


@pytest.mark.asyncio
async def test_openai_client_does_not_retry_billing_quota_errors(monkeypatch):
    calls = 0

    class Completions:
        @staticmethod
        def create(**kwargs):
            nonlocal calls
            calls += 1
            raise _APIError("credit balance exhausted", 429, "credit_balance_exhausted")

    sleep = AsyncMock()
    monkeypatch.setattr("bookiebot.llm.client.asyncio.sleep", sleep)
    client = _client(SimpleNamespace(chat=SimpleNamespace(completions=Completions)))

    with pytest.raises(_APIError, match="credit balance exhausted"):
        await client.complete(messages=[{"role": "user", "content": "hi"}])

    assert calls == 1
    sleep.assert_not_awaited()
