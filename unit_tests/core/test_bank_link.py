import time

import pytest

from bookiebot.core.bank_link import (
    BankLinkTokenError,
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
async def test_plaid_webhook_fails_closed_without_secret(monkeypatch):
    from aiohttp.test_utils import make_mocked_request
    from bookiebot.core import bank_link

    monkeypatch.delenv("PLAID_WEBHOOK_SECRET", raising=False)
    request = make_mocked_request("POST", "/bank/plaid-webhook")

    response = await bank_link._bank_plaid_webhook(request)

    assert response.status == 503


@pytest.mark.asyncio
async def test_plaid_webhook_rejects_missing_invalid_or_query_secret(monkeypatch):
    from aiohttp.test_utils import make_mocked_request
    from bookiebot.core import bank_link

    monkeypatch.setenv("PLAID_WEBHOOK_SECRET", "expected-secret")
    missing = make_mocked_request("POST", "/bank/plaid-webhook")
    query_only = make_mocked_request("POST", "/bank/plaid-webhook?secret=expected-secret")
    wrong = make_mocked_request(
        "POST",
        "/bank/plaid-webhook",
        headers={"X-BookieBot-Webhook-Secret": "wrong-secret"},
    )

    assert (await bank_link._bank_plaid_webhook(missing)).status == 401
    assert (await bank_link._bank_plaid_webhook(query_only)).status == 401
    assert (await bank_link._bank_plaid_webhook(wrong)).status == 401


@pytest.mark.asyncio
async def test_plaid_webhook_accepts_valid_header(monkeypatch):
    import json
    from aiohttp.test_utils import make_mocked_request
    from bookiebot.core import bank_link

    class FakeEvent:
        id = 99

    class FakeService:
        def receive_plaid_webhook(self, payload):
            assert payload == {"webhook_type": "TRANSACTIONS"}
            return FakeEvent()

    monkeypatch.setenv("PLAID_WEBHOOK_SECRET", "expected-secret")
    monkeypatch.setattr(bank_link, "build_banking_service", lambda: FakeService())

    async def fake_json(request):
        return {"webhook_type": "TRANSACTIONS"}

    monkeypatch.setattr(bank_link, "_request_json", fake_json)
    request = make_mocked_request(
        "POST",
        "/bank/plaid-webhook",
        headers={"X-BookieBot-Webhook-Secret": "expected-secret"},
    )

    response = await bank_link._bank_plaid_webhook(request)
    payload = json.loads(response.body.decode("utf-8"))

    assert response.status == 200
    assert payload == {"ok": True, "event_id": 99}
