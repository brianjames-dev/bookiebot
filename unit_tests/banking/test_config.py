from bookiebot.banking.config import load_banking_config
from bookiebot.banking.postgres_store import _postgres_sql


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


def test_postgres_sql_translates_sqlite_placeholders():
    assert _postgres_sql("SELECT * FROM bank_items WHERE id = ? AND owner_key = ?") == (
        "SELECT * FROM bank_items WHERE id = %s AND owner_key = %s"
    )
