import time

import pytest

from bookiebot.core.bank_link import (
    BankLinkTokenError,
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
