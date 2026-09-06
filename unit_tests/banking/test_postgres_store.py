from bookiebot.banking.postgres_store import _PostgresConnection


class _FakeCursor:
    def __init__(self):
        self.calls = []

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def executemany(self, sql, params_seq):
        self.calls.append((sql, params_seq))
        return "ok"


class _FakeConnection:
    def __init__(self):
        self.cursor_instance = _FakeCursor()

    def cursor(self):
        return self.cursor_instance


def test_postgres_connection_executemany_uses_cursor_and_converts_placeholders():
    raw = _FakeConnection()
    conn = _PostgresConnection(raw)

    result = conn.executemany(
        "UPDATE bank_transactions SET removed_at = ? WHERE provider_transaction_id = ?",
        [("now", "txn-1")],
    )

    assert result == "ok"
    assert raw.cursor_instance.calls == [
        (
            "UPDATE bank_transactions SET removed_at = %s WHERE provider_transaction_id = %s",
            [("now", "txn-1")],
        )
    ]


def test_postgres_initializes_shared_import_operation_schema(monkeypatch):
    from contextlib import contextmanager
    from bookiebot.banking.crypto import TokenCipher
    from bookiebot.banking.postgres_store import PostgresBankStore
    from bookiebot.banking.store import BankStore

    class SchemaConnection:
        def __init__(self):
            self.statements = []

        def execute(self, sql, *_):
            self.statements.append(sql)

    postgres_schema = SchemaConnection()
    sqlite_schema = SchemaConnection()
    store = PostgresBankStore('unused-test-url', TokenCipher('test-key'))

    @contextmanager
    def connect():
        yield postgres_schema

    monkeypatch.setattr(store, 'connect', connect)
    store.initialize()
    BankStore._ensure_import_operations_table(store, sqlite_schema)
    assert sqlite_schema.statements[0] in postgres_schema.statements
    assert 'reconciliation_id INTEGER NOT NULL UNIQUE' in sqlite_schema.statements[0]
