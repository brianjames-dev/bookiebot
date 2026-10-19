import time
from unittest.mock import AsyncMock, MagicMock

import pytest

from bookiebot.core.bank_link import (
    BankLinkTokenError,
    _bank_plaid_webhook,
    _link_page_html,
    create_bank_link_setup_token,
    verify_bank_link_setup_token,
)


def test_bank_link_setup_token_round_trips(monkeypatch):
    monkeypatch.setenv("BANK_LINK_SIGNING_SECRET", "test-secret")

    token = create_bank_link_setup_token(actor_key="123", owner_key="brian")
    payload = verify_bank_link_setup_token(token)

    assert payload == {"actor_key": "123", "owner_key": "brian"}


def test_bank_link_setup_token_rejects_tampering(monkeypatch):
    monkeypatch.setenv("BANK_LINK_SIGNING_SECRET", "test-secret")

    token = create_bank_link_setup_token(actor_key="123", owner_key="brian")
    tampered = token.replace("b", "c", 1)

    with pytest.raises(BankLinkTokenError):
        verify_bank_link_setup_token(tampered)


def test_bank_link_setup_token_expires(monkeypatch):
    monkeypatch.setenv("BANK_LINK_SIGNING_SECRET", "test-secret")
    now = int(time.time())
    monkeypatch.setattr(time, "time", lambda: now)
    token = create_bank_link_setup_token(actor_key="123", owner_key="brian", ttl_seconds=60)

    monkeypatch.setattr(time, "time", lambda: now + 61)

    with pytest.raises(BankLinkTokenError):
        verify_bank_link_setup_token(token)


def test_bank_link_page_handles_non_json_api_errors():
    html = _link_page_html("setup-token")

    assert "try {" in html
    assert "JSON.parse(text)" in html
    assert "data = { error: text }" in html


@pytest.mark.asyncio
async def test_plaid_webhook_rejects_when_secret_not_configured(monkeypatch):
    monkeypatch.delenv("PLAID_WEBHOOK_SECRET", raising=False)
    request = MagicMock()

    response = await _bank_plaid_webhook(request)

    assert response.status == 503
    assert b"not configured" in response.body


@pytest.mark.asyncio
async def test_plaid_webhook_rejects_invalid_secret(monkeypatch):
    monkeypatch.setenv("PLAID_WEBHOOK_SECRET", "expected-secret")
    request = MagicMock()
    request.headers = {}
    request.query = {}

    response = await _bank_plaid_webhook(request)

    assert response.status == 401
    assert b"Invalid webhook secret" in response.body


@pytest.mark.asyncio
async def test_plaid_webhook_accepts_valid_secret(monkeypatch):
    monkeypatch.setenv("PLAID_WEBHOOK_SECRET", "expected-secret")
    request = MagicMock()
    request.headers = {"X-BookieBot-Webhook-Secret": "expected-secret"}
    request.query = {}
    request.json = AsyncMock(return_value={"webhook_type": "TRANSACTIONS", "item_id": "item-1"})

    event = MagicMock()
    event.id = 42
    service = MagicMock()
    service.receive_plaid_webhook.return_value = event
    monkeypatch.setattr("bookiebot.core.bank_link.build_banking_service", lambda: service)

    response = await _bank_plaid_webhook(request)

    assert response.status == 200
    service.receive_plaid_webhook.assert_called_once()
