import pytest

from bookiebot.banking.config import load_banking_config
from bookiebot.banking.postgres_store import _postgres_sql
from bookiebot.banking.service import build_banking_service


def test_load_banking_config_uses_database_url_when_present(monkeypatch):
    monkeypatch.setenv("BANK_DATABASE_URL", "postgresql://bookie:secret@localhost:5432/bookiebot")

    config = load_banking_config()

    assert config.database_url == "postgresql://bookie:secret@localhost:5432/bookiebot"


def test_load_banking_config_keeps_sqlite_fallback(monkeypatch):
    monkeypatch.delenv("BANK_DATABASE_URL", raising=False)
    monkeypatch.setenv("BANK_SQLITE_PATH", "data/test-banking.sqlite3")

    config = load_banking_config()

    assert config.database_url is None
    assert str(config.sqlite_path) == "data/test-banking.sqlite3"


def test_build_banking_service_requires_encryption_key(monkeypatch):
    monkeypatch.delenv("BANK_TOKEN_ENCRYPTION_KEY", raising=False)
    monkeypatch.delenv("BANK_DATABASE_URL", raising=False)

    with pytest.raises(ValueError, match="BANK_TOKEN_ENCRYPTION_KEY is required"):
        build_banking_service()


def test_build_banking_service_does_not_use_hardcoded_fallback_key(monkeypatch, tmp_path):
    monkeypatch.setenv("BANK_TOKEN_ENCRYPTION_KEY", "configured-secret")
    monkeypatch.delenv("BANK_DATABASE_URL", raising=False)
    monkeypatch.setenv("BANK_SQLITE_PATH", str(tmp_path / "banking.sqlite3"))
    monkeypatch.setenv("PLAID_CLIENT_ID", "client")
    monkeypatch.setenv("PLAID_SECRET", "secret")

    service = build_banking_service()

    encrypted = service.store.cipher.encrypt("access-token")
    assert "access-token" not in encrypted
    # Wrong key must fail — proves we are not using a shared "missing-dev-key" default.
    from bookiebot.banking.crypto import TokenCipher

    with pytest.raises(ValueError, match="authentication failed"):
        TokenCipher("missing-dev-key").decrypt(encrypted)


def test_postgres_sql_translates_sqlite_placeholders():
    assert _postgres_sql("SELECT * FROM bank_items WHERE id = ? AND owner_key = ?") == (
        "SELECT * FROM bank_items WHERE id = %s AND owner_key = %s"
    )
