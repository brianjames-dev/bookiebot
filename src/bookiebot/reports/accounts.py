"""App-owned identities; existing workbook/actor keys remain financial adapters.

Existing owners are adopted only from validated phone sessions. Verified new
Google subjects enroll into separate managed accounts; existing financial
owners are never inferred from a matching email or name.
"""
from __future__ import annotations

from dataclasses import dataclass
from functools import lru_cache
import hashlib
import re
import secrets
import time
from typing import Any
from uuid import NAMESPACE_URL, uuid4, uuid5

from bookiebot.reports.app_access import (
    AppAccessStore, AppSession, PostgresAppAccessStore, SESSION_TTL_SECONDS,
    build_app_access_store,
)

AUTH_TTL = 600
_TOKEN = re.compile(r"[A-Za-z0-9_-]{43}\Z")


def _now() -> int:
    return int(time.time())


def _hash(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


@dataclass(frozen=True)
class Account:
    id: str
    owner: str
    actor: str
    name: str


def _account(row: Any) -> Account:
    return Account(str(row['user_id']), str(row['owner_key']), str(row['actor_key']), str(row['display_name']))


class AccountConflict(ValueError):
    pass


class AccountStore:
    def __init__(self, access: AppAccessStore):
        self.access = access

    def initialize(self) -> None:
        with self.access.connect(write=True) as db:
            if isinstance(self.access, PostgresAppAccessStore):
                db.execute('SELECT pg_advisory_xact_lock(84392525)')
            db.execute('''CREATE TABLE IF NOT EXISTS app_users (
                user_id TEXT PRIMARY KEY, owner_key TEXT UNIQUE NOT NULL,
                actor_key TEXT NOT NULL, display_name TEXT NOT NULL, created_at BIGINT NOT NULL
            )''')
            db.execute('''CREATE TABLE IF NOT EXISTS app_user_identities (
                provider TEXT NOT NULL, subject TEXT NOT NULL, user_id TEXT NOT NULL,
                email TEXT NOT NULL, created_at BIGINT NOT NULL,
                PRIMARY KEY (provider, subject), UNIQUE (user_id, provider)
            )''')
            db.execute('''CREATE TABLE IF NOT EXISTS app_oauth_flows (
                state_hash TEXT PRIMARY KEY, browser_hash TEXT NOT NULL,
                session_hash TEXT NOT NULL, user_id TEXT NOT NULL,
                nonce TEXT NOT NULL, verifier TEXT NOT NULL, expires_at BIGINT NOT NULL
            )''')

    def for_session(self, session: AppSession, name: str) -> Account:
        """Caller must validate the trusted session's actor/workbook mapping."""
        user_id = uuid5(NAMESPACE_URL, 'https://bookiebot.app/account/' + session.owner_key).hex
        with self.access.connect(write=True) as db:
            db.execute('''INSERT INTO app_users (user_id, owner_key, actor_key, display_name, created_at)
                VALUES (?, ?, ?, ?, ?) ON CONFLICT (owner_key) DO NOTHING''',
                (user_id, session.owner_key, session.actor_key, name, _now()))
            row = db.execute('SELECT * FROM app_users WHERE owner_key = ?', (session.owner_key,)).fetchone()
            return _account(row)

    def profile(self, account: Account) -> dict[str, Any]:
        with self.access.connect() as db:
            google = db.execute("SELECT email FROM app_user_identities WHERE user_id = ? AND provider = 'google'", (account.id,)).fetchone()
        return {'id': account.id, 'name': account.name, 'google': {'connected': google is not None,
                'email': str(google['email']) if google else None}}

    def from_session(self, session: AppSession) -> Account | None:
        """Resolve only an already persisted account; never infer an owner."""
        with self.access.connect() as db:
            row = db.execute('SELECT * FROM app_users WHERE owner_key = ? AND actor_key = ?',
                             (session.owner_key, session.actor_key)).fetchone()
        return _account(row) if row else None

    def start(self, browser: str, *, account: Account | None = None, session_token: str = '') -> dict[str, str]:
        state, nonce, verifier = (secrets.token_urlsafe(32) for _ in range(3))
        with self.access.connect(write=True) as db:
            if isinstance(self.access, PostgresAppAccessStore):
                db.execute('SELECT pg_advisory_xact_lock(84392526)')
            db.execute('DELETE FROM app_oauth_flows WHERE expires_at <= ? OR browser_hash = ?', (_now(), _hash(browser)))
            if db.execute('SELECT COUNT(*) AS count FROM app_oauth_flows').fetchone()['count'] >= 1000:
                raise AccountConflict('Sign-in is busy. Please try again shortly.')
            db.execute('''INSERT INTO app_oauth_flows
                (state_hash, browser_hash, session_hash, user_id, nonce, verifier, expires_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)''',
                (_hash(state), _hash(browser), _hash(session_token) if account else '',
                 account.id if account else '', nonce, verifier, _now() + AUTH_TTL))
        return {'state': state, 'nonce': nonce, 'verifier': verifier}

    def consume(self, state: str, browser: str) -> dict[str, Any] | None:
        if not _TOKEN.fullmatch(state) or not _TOKEN.fullmatch(browser):
            return None
        with self.access.connect(write=True) as db:
            suffix = ' FOR UPDATE' if isinstance(self.access, PostgresAppAccessStore) else ''
            row = db.execute('SELECT * FROM app_oauth_flows WHERE state_hash = ?' + suffix, (_hash(state),)).fetchone()
            if row is None or row['expires_at'] <= _now() or not secrets.compare_digest(row['browser_hash'], _hash(browser)):
                return None
            db.execute('DELETE FROM app_oauth_flows WHERE state_hash = ?', (_hash(state),))
            return dict(row)

    def complete(self, flow: dict[str, Any], *, subject: str, email: str, session_token: str,
                 validate_actor: Any, enroll: bool = False, name: str = '') -> tuple[str, Account]:
        """Bind the verified subject and rotate the first-party session atomically.

        A linking callback must still hold the initiating, unrevoked session.
        Email is display metadata only. Enrollment creates a distinct managed
        account and never selects or adopts an existing workbook.
        """
        with self.access.connect(write=True) as db:
            if isinstance(self.access, PostgresAppAccessStore):
                db.execute('SELECT pg_advisory_xact_lock(84392527)')
            if flow['expires_at'] <= _now():
                raise AccountConflict('Sign-in expired. Please try again.')
            identity = db.execute("SELECT user_id FROM app_user_identities WHERE provider = 'google' AND subject = ?", (subject,)).fetchone()
            if flow['user_id']:
                if not session_token or not secrets.compare_digest(flow['session_hash'], _hash(session_token)):
                    raise AccountConflict('Your app session changed. Link Google again from Settings.')
                lock = ' FOR UPDATE' if isinstance(self.access, PostgresAppAccessStore) else ''
                session = db.execute('SELECT * FROM app_phone_sessions WHERE token_hash = ?' + lock, (_hash(session_token),)).fetchone()
                row = db.execute('SELECT * FROM app_users WHERE user_id = ?', (flow['user_id'],)).fetchone()
                if (session is None or session['expires_at'] <= _now() or row is None
                        or session['owner_key'] != row['owner_key']):
                    raise AccountConflict('Your app session expired. Reconnect before linking Google.')
                if identity is not None and identity['user_id'] != row['user_id']:
                    raise AccountConflict('This Google account is linked to another BookieBot account.')
                existing = db.execute("SELECT subject FROM app_user_identities WHERE provider = 'google' AND user_id = ?", (row['user_id'],)).fetchone()
                if existing is not None and existing['subject'] != subject:
                    raise AccountConflict('A different Google account is already linked.')
                validate_actor(str(session['actor_key']), str(row['owner_key']))
                db.execute('''INSERT INTO app_user_identities (provider, subject, user_id, email, created_at)
                    VALUES ('google', ?, ?, ?, ?) ON CONFLICT (provider, subject) DO UPDATE SET email = excluded.email''',
                    (subject, row['user_id'], email, _now()))
            else:
                if identity is None:
                    if not enroll:
                        raise AccountConflict('Link Google from Settings on your connected BookieBot app first.')
                    identity_id = uuid4().hex
                    display = ' '.join(name.split())[:60] or 'Your budget'
                    db.execute('''INSERT INTO app_users (user_id, owner_key, actor_key, display_name, created_at)
                        VALUES (?, ?, ?, ?, ?)''', (identity_id, 'managed:' + identity_id,
                            'app:' + identity_id, display, _now()))
                    db.execute('''INSERT INTO app_user_identities (provider, subject, user_id, email, created_at)
                        VALUES ('google', ?, ?, ?, ?)''', (subject, identity_id, email, _now()))
                    identity = {'user_id': identity_id}
                row = db.execute('SELECT * FROM app_users WHERE user_id = ?', (identity['user_id'],)).fetchone()
                if row is None:
                    raise AccountConflict('This BookieBot account is unavailable.')
            account = _account(row)
            if account.owner.startswith('managed:'):
                if account.owner != 'managed:' + account.id or account.actor != 'app:' + account.id:
                    raise AccountConflict('This BookieBot account is unavailable.')
            else:
                validate_actor(account.actor, account.owner)
            token = secrets.token_urlsafe(32)
            db.execute('''INSERT INTO app_phone_sessions (token_hash, actor_key, owner_key, expires_at)
                VALUES (?, ?, ?, ?)''', (_hash(token), account.actor, account.owner, _now() + SESSION_TTL_SECONDS))
            if session_token:
                db.execute('DELETE FROM app_phone_sessions WHERE token_hash = ?', (_hash(session_token),))
            return token, account


@lru_cache(maxsize=8)
def account_store(access: AppAccessStore) -> AccountStore:
    store = AccountStore(access)
    store.initialize()
    return store


def build_account_store() -> AccountStore:
    return account_store(build_app_access_store())
