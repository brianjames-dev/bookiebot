import pytest

from bookiebot.banking.config import BankingConfig
from bookiebot.banking.plaid_client import PlaidClient


@pytest.mark.asyncio
async def test_create_link_token_payload(monkeypatch, tmp_path):
    config = BankingConfig(
        plaid_client_id="client",
        plaid_secret="secret",
        plaid_env="sandbox",
        token_encryption_key="key",
        sqlite_path=tmp_path / "banking.sqlite3",
    )
    client = PlaidClient(config)
    captured = {}

    async def fake_post(path, payload):
        captured["path"] = path
        captured["payload"] = payload
        return {"link_token": "link-sandbox-123"}

    monkeypatch.setattr(client, "_post", fake_post)

    link_token = await client.create_link_token(owner_key="brian")

    assert link_token == "link-sandbox-123"
    assert captured["path"] == "/link/token/create"
    assert captured["payload"]["products"] == ["transactions"]
    assert captured["payload"]["country_codes"] == ["US"]
    assert captured["payload"]["user"] == {"client_user_id": "brian"}


@pytest.mark.asyncio
async def test_create_link_token_includes_redirect_uri_when_configured(tmp_path):
    config = BankingConfig(
        plaid_client_id="client",
        plaid_secret="secret",
        plaid_env="sandbox",
        token_encryption_key="key",
        sqlite_path=tmp_path / "banking.sqlite3",
        plaid_redirect_uri="https://example.test/bank/link",
    )
    client = PlaidClient(config)
    captured = {}

    async def fake_post(path, payload):
        captured["payload"] = payload
        return {"link_token": "link-sandbox-123"}

    client._post = fake_post

    await client.create_link_token(owner_key="brian")

    assert captured["payload"]["redirect_uri"] == "https://example.test/bank/link"


@pytest.mark.asyncio
async def test_remove_item_calls_plaid_item_remove(tmp_path):
    config = BankingConfig(
        plaid_client_id="client",
        plaid_secret="secret",
        plaid_env="sandbox",
        token_encryption_key="key",
        sqlite_path=tmp_path / "banking.sqlite3",
    )
    client = PlaidClient(config)
    captured = {}

    async def fake_post(path, payload):
        captured["path"] = path
        captured["payload"] = payload
        return {"removed": True}

    client._post = fake_post

    response = await client.remove_item("access-sandbox-123")

    assert response == {"removed": True}
    assert captured == {
        "path": "/item/remove",
        "payload": {"access_token": "access-sandbox-123"},
    }
