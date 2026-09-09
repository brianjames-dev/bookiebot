"""Widget pairing/grant contracts, including real isolated PostgreSQL races."""
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from dataclasses import FrozenInstanceError
import hashlib
import os
import re
from threading import Barrier
from uuid import uuid4

import pytest

from bookiebot.reports import widget_store
from bookiebot.reports.app_access import AppAccessStore, PostgresAppAccessStore
from bookiebot.reports.widget_store import WidgetLimitError, WidgetNotFoundError, WidgetStore, WidgetValidationError


@pytest.fixture
def clock(monkeypatch):
    now = [1_800_000_000]
    monkeypatch.setattr(widget_store, "_now", lambda: now[0])
    return now


@pytest.fixture(params=["sqlite", "postgres"])
def access(request, tmp_path, clock):
    if request.param == "sqlite":
        yield AppAccessStore(tmp_path / "widgets.sqlite3")
        return
    url = os.getenv("BOOKIEBOT_TEST_POSTGRES_URL", "")
    if not url:
        pytest.skip("Set BOOKIEBOT_TEST_POSTGRES_URL for isolated PostgreSQL widget contracts")
    import psycopg
    from psycopg import sql
    from psycopg.conninfo import make_conninfo
    schema = "bookiebot_widgets_" + uuid4().hex
    with psycopg.connect(url, autocommit=True, connect_timeout=5) as admin:
        admin.execute(sql.SQL("CREATE SCHEMA {}").format(sql.Identifier(schema)))
        try:
            yield PostgresAppAccessStore(make_conninfo(url, options=f"-csearch_path={schema}", connect_timeout=5))
        finally:
            admin.execute(sql.SQL("DROP SCHEMA {} CASCADE").format(sql.Identifier(schema)))


@pytest.fixture
def store(access):
    result = WidgetStore(access)
    result.initialize()
    return result


def reopen(store):
    access = store.access
    return WidgetStore(PostgresAppAccessStore(access.database_url) if isinstance(access, PostgresAppAccessStore)
                       else AppAccessStore(access.path))


def issue(store, owner="brian", mode="current"):
    return store.issue_pairing("discord:1" if owner == "brian" else "discord:2", owner, f"{owner}'s iPhone", mode)


def redeem(store, owner="brian", mode="current"):
    pairing = issue(store, owner, mode)
    result = store.consume_pairing(pairing["pairingToken"])
    assert result is not None
    return result


def test_concurrent_schema_initialization_safe(access):
    gate = Barrier(4)

    def initialize(_):
        gate.wait(timeout=10)
        WidgetStore(access).initialize()

    with ThreadPoolExecutor(max_workers=4) as pool:
        list(pool.map(initialize, range(4)))
    assert redeem(WidgetStore(access))[1].owner_key == "brian"


def test_pairing_and_grant_persist_with_hashes_only(store, clock):
    pairing = issue(store, mode="projected")
    raw = pairing["pairingToken"]
    assert re.fullmatch(r"bbw_pair_[A-Za-z0-9_-]{43}", raw)
    with store.access.connect() as db:
        stored = dict(db.execute("SELECT * FROM app_widget_pairings").fetchone())
    assert stored["token_hash"] == hashlib.sha256(raw.encode()).hexdigest()
    assert raw not in str(stored)
    assert stored["expires_at"] == clock[0] + 600
    result = reopen(store).consume_pairing(raw)
    assert result is not None
    token, grant = result
    assert re.fullmatch(r"bbw_read_[A-Za-z0-9_-]{43}", token)
    assert grant.id == pairing["id"] and grant.mode == "projected"
    assert grant.actor_key == "discord:1" and grant.owner_key == "brian"
    assert grant.expires_at == clock[0] + 365 * 86400
    assert reopen(store).get_grant(token) == grant
    assert store.consume_pairing(raw) is None
    with store.access.connect() as db:
        stored = dict(db.execute("SELECT * FROM app_widget_grants").fetchone())
        assert db.execute("SELECT COUNT(*) AS count FROM app_widget_pairings").fetchone()["count"] == 0
    assert stored["token_hash"] == hashlib.sha256(token.encode()).hexdigest()
    assert token not in str(stored) and raw not in str(stored)
    with pytest.raises(FrozenInstanceError):
        grant.owner_key = "hannah"


def test_listing_never_exposes_credentials_or_actor_identifiers(store):
    token, grant = redeem(store)
    pairing = issue(store)
    records = reopen(store).list_connections("brian")["connections"]
    assert {record["status"] for record in records} == {"active", "pending"}
    assert {record["id"] for record in records} == {grant.id, pairing["id"]}
    for record in records:
        assert set(record) == {"id", "label", "mode", "status", "createdAt", "expiresAt", "lastUsedAt"}
    assert token not in str(records) and pairing["pairingToken"] not in str(records)
    assert "discord:1" not in str(records)
    assert store.list_connections("hannah") == {"connections": []}


def test_widget_namespaces_do_not_authenticate_as_phone_sessions(store):
    store.access.initialize()
    phone_pairing = store.access.issue_pairing("discord:1", "brian")
    phone_result = store.access.consume_pairing(phone_pairing)
    assert phone_result is not None
    phone_token, phone_session = phone_result
    pending = issue(store)["pairingToken"]
    widget_token, _ = redeem(store)
    for token in (phone_pairing, phone_token, pending):
        assert store.get_grant(token) is None
    for token in (phone_pairing, phone_token, widget_token):
        assert store.consume_pairing(token) is None
    for token in (pending, widget_token):
        assert store.access.get_session(token) is None
        assert store.access.consume_pairing(token) is None
    # The independent revocation does not sign out the phone or affect its bearer.
    store.revoke_owner("brian")
    assert store.access.get_session(phone_token) == phone_session


@pytest.mark.parametrize("token", ["", "incorrect", "A" * 43, "bbw_read_" + "!" * 43,
                                  "bbw_pair_" + "A" * 43, "x" * 100_000, None, 1])
def test_malformed_or_unknown_tokens_fail_closed(store, token):
    valid, grant = redeem(store)
    assert store.consume_pairing(token) is None
    assert store.get_grant(token) is None
    assert not store.touch_grant(token)
    assert store.get_grant(valid) == grant


def test_pairing_and_grant_expiry_is_inclusive(store, clock):
    pairing = issue(store)
    clock[0] += widget_store.PAIRING_TTL_SECONDS
    assert store.consume_pairing(pairing["pairingToken"]) is None
    assert store.list_connections("brian") == {"connections": []}
    token, grant = redeem(store)
    clock[0] = grant.expires_at - 1
    assert store.get_grant(token) == grant
    clock[0] += 1
    assert store.get_grant(token) is None
    assert not store.touch_grant(token)
    assert store.list_connections("brian") == {"connections": []}
    with pytest.raises(WidgetNotFoundError):
        store.set_mode("brian", grant.id, "projected")


def test_touch_records_read_but_never_extends_expiry(store, clock):
    token, grant = redeem(store)
    assert grant.last_used_at is None
    clock[0] += 60
    assert reopen(store).touch_grant(token)
    updated = store.get_grant(token)
    assert updated is not None and updated.last_used_at == clock[0]
    assert updated.expires_at == grant.expires_at
    assert store.list_connections("brian")["connections"][0]["lastUsedAt"] is not None
    store.revoke("brian", grant.id)
    assert not store.touch_grant(token)


def test_revocation_is_owner_scoped_idempotent_for_active_and_pending(store):
    brian, grant = redeem(store)
    pending = issue(store)
    hannah, other = redeem(store, "hannah")
    store.revoke("hannah", grant.id)
    store.revoke("hannah", pending["id"])
    assert store.get_grant(brian) == grant
    assert len(store.list_connections("brian")["connections"]) == 2
    reopen(store).revoke("brian", pending["id"])
    store.revoke("brian", pending["id"])
    assert store.consume_pairing(pending["pairingToken"]) is None
    store.revoke("brian", grant.id)
    store.revoke("brian", grant.id)
    assert store.get_grant(brian) is None
    assert store.get_grant(hannah) == other


def test_owner_revoke_clears_only_that_owners_widgets(store):
    token, _ = redeem(store)
    pending = issue(store)
    other, other_grant = redeem(store, "hannah")
    other_pending = issue(store, "hannah")
    reopen(store).revoke_owner("brian")
    assert store.get_grant(token) is None
    assert store.consume_pairing(pending["pairingToken"]) is None
    assert store.list_connections("brian") == {"connections": []}
    assert store.get_grant(other) == other_grant
    assert store.consume_pairing(other_pending["pairingToken"]) is not None


def test_settings_mode_is_scoped_and_carried_through_pairing(store):
    pending = issue(store)
    with pytest.raises(WidgetNotFoundError):
        store.set_mode("hannah", pending["id"], "projected")
    changed = store.set_mode("brian", pending["id"], "projected")
    assert changed["mode"] == "projected" and changed["status"] == "pending"
    result = store.consume_pairing(pending["pairingToken"])
    assert result is not None
    token, grant = result
    assert grant.mode == "projected"
    changed = reopen(store).set_mode("brian", grant.id, "current")
    assert changed["mode"] == "current" and changed["status"] == "active"
    updated = store.get_grant(token)
    assert updated is not None and updated.mode == "current"
    assert updated.expires_at == grant.expires_at


@pytest.mark.parametrize("field,value", [("owner_key", "other"), ("actor_key", ""), ("actor_key", "a" * 129),
    ("actor_key", "actor\n"), ("label", ""), ("label", "   "), ("label", "a" * 81),
    ("label", "phone\nname"), ("label", "phone\u202ename"), ("label", 1), ("mode", "Current"), ("mode", [])])
def test_invalid_pairing_has_no_side_effects(store, field, value):
    details = {"actor_key": "discord:1", "owner_key": "brian", "label": "My iPhone", "mode": "current"}
    with pytest.raises(WidgetValidationError):
        store.issue_pairing(**{**details, field: value})
    assert store.list_connections("brian") == {"connections": []}


def test_owner_connection_limit_combines_pending_and_active_and_cleans_expired(store, clock):
    token, _ = redeem(store)
    for _ in range(4):
        issue(store)
    with pytest.raises(WidgetLimitError):
        issue(store)
    assert len(store.list_connections("brian")["connections"]) == 5
    assert issue(store, "hannah")
    clock[0] += widget_store.PAIRING_TTL_SECONDS
    assert issue(store)
    assert store.get_grant(token) is not None
    assert len(store.list_connections("brian")["connections"]) == 2
    with store.access.connect() as db:
        count = db.execute("SELECT COUNT(*) AS count FROM app_widget_pairings WHERE owner_key = ?", ("brian",)).fetchone()
        assert count["count"] == 1


def test_concurrent_issuance_cannot_exceed_owner_limit(store):
    gate = Barrier(8)

    def create(_):
        gate.wait(timeout=10)
        try:
            return issue(reopen(store))
        except WidgetLimitError:
            return None

    with ThreadPoolExecutor(max_workers=8) as pool:
        results = list(pool.map(create, range(8)))
    assert sum(result is not None for result in results) == 5
    assert len(store.list_connections("brian")["connections"]) == 5


def test_concurrent_redemption_consumes_once(store):
    pending = issue(store)
    gate = Barrier(8)

    def consume(_):
        gate.wait(timeout=10)
        return reopen(store).consume_pairing(pending["pairingToken"])

    with ThreadPoolExecutor(max_workers=8) as pool:
        results = list(pool.map(consume, range(8)))
    successes = [result for result in results if result is not None]
    assert len(successes) == 1
    assert store.get_grant(successes[0][0]) == successes[0][1]
    assert len(store.list_connections("brian")["connections"]) == 1


def test_failed_grant_insert_rolls_back_redemption(store, monkeypatch):
    existing, existing_grant = redeem(store)
    pending = issue(store)
    with monkeypatch.context() as patch:
        patch.setattr(widget_store.secrets, "token_urlsafe", lambda size: existing[len(widget_store.GRANT_PREFIX):])
        with pytest.raises(Exception, match="UNIQUE|duplicate key"):
            store.consume_pairing(pending["pairingToken"])
    assert store.consume_pairing(pending["pairingToken"]) is not None
    assert store.get_grant(existing) == existing_grant


def test_pairing_expiring_while_waiting_for_lock_is_not_consumed(store, clock, monkeypatch):
    pending = issue(store)
    expiry = clock[0] + widget_store.PAIRING_TTL_SECONDS
    connect = store.access.connect

    class DelayedSelect:
        def __init__(self, connection):
            self.connection = connection

        def execute(self, sql, params=()):
            result = self.connection.execute(sql, params)
            if sql.startswith("SELECT owner_key FROM app_widget_owners"):
                clock[0] = expiry
            return result

    @contextmanager
    def after_lock(*, write=False):
        with connect(write=write) as connection:
            yield DelayedSelect(connection)

    monkeypatch.setattr(store.access, "connect", after_lock)
    assert store.consume_pairing(pending["pairingToken"]) is None
    with connect() as db:
        assert db.execute("SELECT COUNT(*) AS count FROM app_widget_grants").fetchone()["count"] == 0


@pytest.mark.parametrize("whole_owner", [False, True])
def test_revocation_racing_redemption_leaves_no_valid_grant(store, whole_owner):
    pending = issue(store)
    gate = Barrier(2)

    def consume():
        gate.wait(timeout=10)
        return reopen(store).consume_pairing(pending["pairingToken"])

    def revoke():
        gate.wait(timeout=10)
        separate = reopen(store)
        if whole_owner:
            separate.revoke_owner("brian")
        else:
            separate.revoke("brian", pending["id"])

    with ThreadPoolExecutor(max_workers=2) as pool:
        consumed, revoked = pool.submit(consume), pool.submit(revoke)
        result = consumed.result(timeout=30)
        revoked.result(timeout=30)
    assert store.list_connections("brian") == {"connections": []}
    if result is not None:
        assert store.get_grant(result[0]) is None
