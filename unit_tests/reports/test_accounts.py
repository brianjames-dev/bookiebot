"""Identity/provider boundaries on SQLite and disposable PostgreSQL schemas."""
from concurrent.futures import ThreadPoolExecutor
import os
import secrets
from uuid import uuid4

import pytest

from bookiebot.reports import accounts
from bookiebot.reports.app_access import AppAccessStore, PostgresAppAccessStore


@pytest.fixture(params=['sqlite', 'postgres'])
def store(request, tmp_path):
    if request.param == 'sqlite':
        access = AppAccessStore(tmp_path / 'accounts.sqlite3')
        access.initialize()
        store = accounts.AccountStore(access)
        store.initialize()
        yield store
        return
    url = os.getenv('BOOKIEBOT_TEST_POSTGRES_URL', '')
    if not url:
        pytest.skip('Set BOOKIEBOT_TEST_POSTGRES_URL for isolated PostgreSQL accounts')
    import psycopg
    from psycopg import sql
    from psycopg.conninfo import make_conninfo
    schema = 'bookiebot_accounts_' + uuid4().hex
    with psycopg.connect(url, autocommit=True, connect_timeout=5) as admin:
        admin.execute(sql.SQL('CREATE SCHEMA {}').format(sql.Identifier(schema)))
        try:
            access = PostgresAppAccessStore(make_conninfo(url, options=f'-csearch_path={schema}', connect_timeout=5))
            access.initialize()
            store = accounts.AccountStore(access)
            store.initialize()
            yield store
        finally:
            admin.execute(sql.SQL('DROP SCHEMA {} CASCADE').format(sql.Identifier(schema)))


def person(store, owner='brian'):
    token, session = store.access.consume_pairing(store.access.issue_pairing('fixture:' + owner, owner))
    return token, store.for_session(session, owner.title())


def flow(store, account=None, token=''):
    browser = secrets.token_urlsafe(32)
    result = store.start(browser, account=account, session_token=token)
    return store.consume(result['state'], browser)


def complete(store, item, subject='google-sub-1', email='same@example.test', token=''):
    def validate(actor, owner):
        assert actor == 'fixture:' + owner
    return store.complete(item, subject=subject, email=email, session_token=token, validate_actor=validate)


def test_identity_stays_stable_across_legacy_sessions_and_restarts(store):
    token, user = person(store)
    assert person(store)[1].id == user.id
    assert accounts.AccountStore(store.access).for_session(store.access.get_session(token), 'Brian').id == user.id
    assert person(store, 'hannah')[1].id != user.id
    assert store.profile(user)['google'] == {'connected': False, 'email': None}
    assert store.access.get_session(token).owner_key == 'brian'


def test_link_then_login_rotates_first_party_session_and_never_matches_email(store):
    token, user = person(store)
    new, linked = complete(store, flow(store, user, token), token=token)
    assert linked.id == user.id
    assert store.access.get_session(token) is None
    assert store.access.get_session(new).owner_key == 'brian'
    assert store.profile(user)['google'] == {'connected': True, 'email': 'same@example.test'}
    login, authenticated = complete(store, flow(store))
    assert authenticated.id == user.id and store.access.get_session(login).owner_key == 'brian'
    with pytest.raises(accounts.AccountConflict, match='Link Google'):
        complete(store, flow(store), subject='different-sub')
    other, hannah = person(store, 'hannah')
    with pytest.raises(accounts.AccountConflict, match='another BookieBot'):
        complete(store, flow(store, hannah, other), token=other)
    # Identical emails are never an automatic merge; different verified subjects
    # can be explicitly linked to their separately authenticated accounts.
    _, second = complete(store, flow(store, hannah, other), subject='different-sub', token=other)
    assert second.id == hannah.id != user.id


def test_link_requires_same_unrevoked_session_and_same_owner(store):
    token, user = person(store)
    other, _ = person(store)
    with pytest.raises(accounts.AccountConflict, match='session changed'):
        complete(store, flow(store, user, token), token=other)
    pending = flow(store, user, token)
    store.access.revoke_owner('brian')
    with pytest.raises(accounts.AccountConflict, match='expired'):
        complete(store, pending, token=token)
    assert not store.profile(user)['google']['connected']


def test_state_is_hashed_browser_bound_expiring_and_exactly_once(store, monkeypatch):
    browser = secrets.token_urlsafe(32)
    result = store.start(browser)
    with store.access.connect() as db:
        raw = str(dict(db.execute('SELECT * FROM app_oauth_flows').fetchone()))
    assert result['state'] not in raw and browser not in raw
    assert store.consume(result['state'], secrets.token_urlsafe(32)) is None
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda _: store.consume(result['state'], browser), range(2)))
    assert sum(item is not None for item in results) == 1
    result = store.start(browser)
    now = accounts._now()
    monkeypatch.setattr(accounts, '_now', lambda: now + accounts.AUTH_TTL)
    assert store.consume(result['state'], browser) is None
    assert store.consume('invalid', browser) is None


def test_google_link_cannot_replace_existing_identity_or_route_to_changed_workbook(store):
    token, user = person(store)
    new, _ = complete(store, flow(store, user, token), token=token)
    with pytest.raises(accounts.AccountConflict, match='different Google'):
        complete(store, flow(store, user, new), subject='new-sub', token=new)
    def deny(*_):
        raise ValueError('workbook adapter changed')
    with pytest.raises(ValueError):
        store.complete(flow(store), subject='google-sub-1', email='x@example.test', session_token='', validate_actor=deny)
    assert store.access.get_session(new) is not None


def test_concurrent_schema_and_account_creation_are_idempotent(store):
    token, user = person(store)
    session = store.access.get_session(token)
    def initialize(_):
        reopened = accounts.AccountStore(store.access)
        reopened.initialize()
        return reopened.for_session(session, 'Brian').id
    with ThreadPoolExecutor(max_workers=4) as pool:
        assert set(pool.map(initialize, range(4))) == {user.id}
