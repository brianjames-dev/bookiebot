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
