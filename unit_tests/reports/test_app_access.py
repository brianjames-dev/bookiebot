"""Phone-access contracts run in SQLite and opt-in isolated PostgreSQL schemas."""
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from dataclasses import FrozenInstanceError
import hashlib
import os
import re
import threading
import uuid

import pytest

from bookiebot.reports import app_access
from bookiebot.reports.app_access import AppAccessStore, AppSession, PostgresAppAccessStore


@pytest.fixture
def clock(monkeypatch):
    now = [1_800_000_000]
    monkeypatch.setattr(app_access, "_now", lambda: now[0])
    return now


@pytest.fixture(params=["sqlite", "postgres"])
def store(request, tmp_path, clock):
    if request.param == "sqlite":
        instance = AppAccessStore(tmp_path / "app-access.sqlite3")
        instance.initialize()
        yield instance
        return
    database_url = os.getenv("BOOKIEBOT_TEST_POSTGRES_URL", "").strip()
    if not database_url:
        pytest.skip("Set BOOKIEBOT_TEST_POSTGRES_URL to run real Postgres phone-access contracts")
    import psycopg
    from psycopg import sql
    from psycopg.conninfo import make_conninfo

    schema = "bookiebot_app_access_" + uuid.uuid4().hex
    with psycopg.connect(database_url, autocommit=True, connect_timeout=5) as admin:
        admin.execute(sql.SQL("CREATE SCHEMA {}").format(sql.Identifier(schema)))
        try:
            isolated_url = make_conninfo(database_url, options=f"-csearch_path={schema}", connect_timeout=5)
            instance = PostgresAppAccessStore(isolated_url)
            instance.initialize()
            with instance.connect() as connection:
                assert connection.execute("SELECT current_schema() AS name").fetchone()["name"] == schema
            yield instance
        finally:
            admin.execute(sql.SQL("DROP SCHEMA {} CASCADE").format(sql.Identifier(schema)))


def reopen(store):
    if isinstance(store, PostgresAppAccessStore):
        return PostgresAppAccessStore(store.database_url)
    return AppAccessStore(store.path)


def redeem(store, actor="discord:1", owner="brian"):
    result = store.consume_pairing(store.issue_pairing(actor, owner))
    assert result is not None
    return result


def test_access_pairing_and_session_persist_without_raw_tokens(store, clock):
    pairing = store.issue_pairing("discord:123", "brian")
    assert re.fullmatch(r"[A-Za-z0-9_-]{43}", pairing)
    expected = AppSession("discord:123", "brian", clock[0] + app_access.PAIRING_TTL_SECONDS)
    assert reopen(store).peek_pairing(pairing) == expected
    with store.connect() as connection:
        stored = dict(connection.execute("SELECT * FROM app_phone_pairings").fetchone())
    assert stored["token_hash"] == hashlib.sha256(pairing.encode()).hexdigest()
    assert pairing not in str(stored)
    redeemed = reopen(store).consume_pairing(pairing)
    assert redeemed is not None
    session_token, session = redeemed
    assert session == AppSession("discord:123", "brian", clock[0] + app_access.SESSION_TTL_SECONDS)
    assert session_token != pairing
    assert re.fullmatch(r"[A-Za-z0-9_-]{43}", session_token)
    assert reopen(store).get_session(session_token) == session
    assert store.consume_pairing(pairing) is None
    assert store.peek_pairing(pairing) is None
    assert store.get_session(pairing) is None
    assert store.peek_pairing(session_token) is None
    with store.connect() as connection:
        stored = dict(connection.execute("SELECT * FROM app_phone_sessions").fetchone())
    assert stored["token_hash"] == hashlib.sha256(session_token.encode()).hexdigest()
    assert session_token not in str(stored)
    with pytest.raises(FrozenInstanceError):
        session.owner_key = "hannah"


def test_access_expiry_is_inclusive_and_peek_does_not_mutate(store, clock):
    pairing = store.issue_pairing("discord:1", "brian")
    expiry = clock[0] + app_access.PAIRING_TTL_SECONDS
    clock[0] = expiry - 1
    assert store.peek_pairing(pairing) is not None
    clock[0] = expiry
    assert store.peek_pairing(pairing) is None
    assert store.consume_pairing(pairing) is None
    with store.connect() as connection:
        assert connection.execute("SELECT COUNT(*) AS total FROM app_phone_pairings").fetchone()["total"] == 1
    token, session = redeem(store)
    clock[0] = session.expires_at - 1
    assert store.get_session(token) == session
    clock[0] = session.expires_at
    assert store.get_session(token) is None


def test_access_initialization_creates_only_phone_access_tables(store):
    store.initialize()
    if isinstance(store, PostgresAppAccessStore):
        query = "SELECT tablename AS name FROM pg_tables WHERE schemaname = current_schema()"
    else:
        query = "SELECT name FROM sqlite_master WHERE type = 'table'"
    with store.connect() as connection:
        names = {row["name"] for row in connection.execute(query).fetchall()}
    assert names == {"app_phone_pairings", "app_phone_sessions"}


@pytest.mark.parametrize("token", ["", "incorrect", "A" * 43, "!" * 43, "x" * 100_000])
def test_access_wrong_and_malformed_tokens_cannot_authenticate(store, token):
    valid, session = redeem(store)
    assert store.peek_pairing(token) is None
    assert store.consume_pairing(token) is None
    assert store.get_session(token) is None
    store.revoke_session(token)
    assert store.get_session(valid) == session


def test_access_session_and_owner_revocation_are_isolated(store):
    first, _ = redeem(store, "discord:1", "brian")
    second, _ = redeem(store, "discord:2", "brian")
    pending = store.issue_pairing("discord:1", "brian")
    other, other_session = redeem(store, "discord:3", "hannah")
    other_pending = store.issue_pairing("discord:3", "hannah")
    reopen(store).revoke_session(first)
    assert store.get_session(first) is None
    assert store.get_session(second) is not None
    assert store.peek_pairing(pending) is not None
    reopen(store).revoke_owner("brian")
    assert store.get_session(second) is None
    assert store.peek_pairing(pending) is None
    assert store.consume_pairing(pending) is None
    assert store.get_session(other) == other_session
    assert store.peek_pairing(other_pending) is not None


def test_access_concurrent_connections_redeem_only_once(store):
    pairing = store.issue_pairing("discord:1", "brian")
    gate = threading.Barrier(8)

    def consume():
        independent = reopen(store)
        gate.wait(timeout=10)
        return independent.consume_pairing(pairing)

    with ThreadPoolExecutor(max_workers=8) as executor:
        results = list(executor.map(lambda _: consume(), range(8)))
    successes = [result for result in results if result is not None]
    assert len(successes) == 1
    assert store.get_session(successes[0][0]) == successes[0][1]
    with store.connect() as connection:
        assert connection.execute("SELECT COUNT(*) AS total FROM app_phone_sessions").fetchone()["total"] == 1


def test_access_failed_session_creation_rolls_back_pairing_redemption(store, monkeypatch):
    existing, _ = redeem(store)
    pairing = store.issue_pairing("discord:1", "brian")
    with monkeypatch.context() as patch:
        patch.setattr(app_access.secrets, "token_urlsafe", lambda size: existing)
        with pytest.raises(Exception, match="UNIQUE|duplicate key"):
            store.consume_pairing(pairing)
    assert store.peek_pairing(pairing) is not None
    assert store.consume_pairing(pairing) is not None
    assert store.get_session(existing) is not None


def test_access_pairing_expiring_during_lock_acquisition_cannot_redeem(store, clock, monkeypatch):
    pairing = store.issue_pairing("discord:1", "brian")
    expiry = clock[0] + app_access.PAIRING_TTL_SECONDS
    connect = store.connect

    class DelayedSelect:
        def __init__(self, connection):
            self.connection = connection

        def execute(self, sql, params=()):
            result = self.connection.execute(sql, params)
            if sql.startswith("SELECT actor_key"):
                clock[0] = expiry
            return result

    @contextmanager
    def after_lock(*, write=False):
        with connect(write=write) as connection:
            yield DelayedSelect(connection)

    monkeypatch.setattr(store, "connect", after_lock)
    assert store.consume_pairing(pairing) is None
    with connect() as connection:
        assert connection.execute("SELECT COUNT(*) AS total FROM app_phone_sessions").fetchone()["total"] == 0


def test_access_owner_revoke_racing_redemption_leaves_no_session(store):
    pairings = [store.issue_pairing("discord:1", "brian") for _ in range(8)]
    gate = threading.Barrier(9)

    def consume(pairing):
        gate.wait(timeout=10)
        return reopen(store).consume_pairing(pairing)

    def revoke():
        gate.wait(timeout=10)
        reopen(store).revoke_owner("brian")

    with ThreadPoolExecutor(max_workers=9) as executor:
        futures = [executor.submit(consume, token) for token in pairings]
        revoked = executor.submit(revoke)
        results = [future.result(timeout=30) for future in futures]
        revoked.result(timeout=30)
    assert all(store.consume_pairing(token) is None for token in pairings)
    assert all(result is None or store.get_session(result[0]) is None for result in results)


@pytest.fixture
def clean_factory(monkeypatch):
    for key in ("BOOKIEBOT_APP_DATABASE_URL", "BANK_DATABASE_URL", "DATABASE_URL", "BOOKIEBOT_APP_SQLITE_PATH",
                "RAILWAY_ENVIRONMENT_ID", "RAILWAY_PROJECT_ID", "RAILWAY_VOLUME_MOUNT_PATH"):
        monkeypatch.delenv(key, raising=False)
    app_access._build_store.cache_clear()
    yield
    app_access._build_store.cache_clear()


def test_access_factory_caches_by_effective_configuration(clean_factory, tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    first = app_access.build_app_access_store()
    assert first.path == tmp_path / "data/app-access.sqlite3"
    assert app_access.build_app_access_store() is first
    monkeypatch.setenv("BOOKIEBOT_APP_SQLITE_PATH", str(tmp_path / "second.sqlite3"))
    second = app_access.build_app_access_store()
    assert second is not first
    assert second.path.exists()


def test_access_factory_database_precedence_without_banking_setup(clean_factory, monkeypatch):
    initialized = []
    monkeypatch.setattr(PostgresAppAccessStore, "initialize", lambda store: initialized.append(store.database_url))
    for key, expected in (("DATABASE_URL", "postgresql://fallback"),
                          ("BANK_DATABASE_URL", "postgresql://bank"),
                          ("BOOKIEBOT_APP_DATABASE_URL", "postgresql://app")):
        monkeypatch.setenv(key, expected)
        store = app_access.build_app_access_store()
        assert isinstance(store, PostgresAppAccessStore)
        assert store.database_url == expected
        assert app_access.build_app_access_store() is store
    assert initialized == ["postgresql://fallback", "postgresql://bank", "postgresql://app"]


def test_access_railway_requires_durable_storage(clean_factory, tmp_path, monkeypatch):
    monkeypatch.setenv("RAILWAY_PROJECT_ID", "test-project")
    monkeypatch.setenv("BOOKIEBOT_APP_SQLITE_PATH", str(tmp_path / "ephemeral.sqlite3"))
    with pytest.raises(RuntimeError, match="Configure BOOKIEBOT_APP_DATABASE_URL or mount a Railway volume"):
        app_access.build_app_access_store()
    volume = tmp_path / "volume"
    monkeypatch.setenv("RAILWAY_VOLUME_MOUNT_PATH", str(volume))
    with pytest.raises(RuntimeError, match="inside the mounted Railway volume"):
        app_access.build_app_access_store()
    monkeypatch.delenv("BOOKIEBOT_APP_SQLITE_PATH")
    default = app_access.build_app_access_store()
    assert default.path == volume / "app-access.sqlite3"
    monkeypatch.setenv("BOOKIEBOT_APP_SQLITE_PATH", str(volume / "nested/custom.sqlite3"))
    assert app_access.build_app_access_store().path == volume / "nested/custom.sqlite3"
    (volume / "escape").symlink_to(tmp_path, target_is_directory=True)
    monkeypatch.setenv("BOOKIEBOT_APP_SQLITE_PATH", str(volume / "escape/ephemeral.sqlite3"))
    with pytest.raises(RuntimeError, match="inside the mounted Railway volume"):
        app_access.build_app_access_store()
