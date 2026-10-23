from bookiebot.banking.config import BankingConfig, load_banking_config
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


def test_service_reuses_the_initialized_store_only_for_the_same_configuration(tmp_path, monkeypatch):
    from dataclasses import replace
    from bookiebot.banking import service
    config = BankingConfig('client', 'secret', 'sandbox', 'test', tmp_path / 'cache.sqlite3')
    monkeypatch.setattr(service, 'load_banking_config', lambda: config)
    first = service.build_banking_service()
    assert first is service.build_banking_service()
    config = replace(config, sqlite_path=tmp_path / 'changed.sqlite3')
    assert service.build_banking_service().store is not first.store
