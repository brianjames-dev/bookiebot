"""Accepted bill memberships and refresh cursors, never a second money ledger.

Bill plans/charges stay in their existing hidden Sheets tabs. Memberships point
to those stable IDs; amounts and payments are always read from their sources.
"""
from __future__ import annotations

import json
import hashlib
import time
from typing import Any
from uuid import uuid5, NAMESPACE_URL

from bookiebot.reports.accounts import Account, AccountConflict, AccountStore
from bookiebot.reports.app_access import PostgresAppAccessStore


class SharedBillStore:
    def __init__(self, accounts: AccountStore):
        self.accounts = accounts
        self.access = accounts.access

    def initialize(self) -> None:
        self.accounts.initialize()
        with self.access.connect(write=True) as db:
            if isinstance(self.access, PostgresAppAccessStore):
                db.execute('SELECT pg_advisory_xact_lock(84392528)')
            db.execute('''CREATE TABLE IF NOT EXISTS app_bill_shares (
                id TEXT PRIMARY KEY, payer_id TEXT NOT NULL, member_id TEXT NOT NULL,
                plan_id TEXT NOT NULL, member_plan_id TEXT NOT NULL, status TEXT NOT NULL,
                revision BIGINT NOT NULL, created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL,
                UNIQUE (payer_id, member_id, plan_id)
            )''')
            db.execute('''CREATE TABLE IF NOT EXISTS app_bill_share_events (
                request_id TEXT PRIMARY KEY, actor_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
                share_id TEXT NOT NULL, action TEXT NOT NULL, result TEXT NOT NULL, created_at BIGINT NOT NULL
            )''')
            db.execute('''CREATE TABLE IF NOT EXISTS app_shared_changes (
                owner_key TEXT PRIMARY KEY, revision BIGINT NOT NULL
            )''')
            db.execute('CREATE INDEX IF NOT EXISTS app_bill_shares_member_idx ON app_bill_shares(member_id, status)')

    def links(self, account: Account) -> list[dict[str, Any]]:
        with self.access.connect() as db:
            return [dict(row) for row in db.execute('''SELECT s.*, p.display_name AS payer_name,
                p.owner_key AS payer_owner, p.actor_key AS payer_actor,
                m.display_name AS member_name, m.owner_key AS member_owner, m.actor_key AS member_actor
                FROM app_bill_shares s JOIN app_users p ON s.payer_id = p.user_id
                JOIN app_users m ON s.member_id = m.user_id
                WHERE s.payer_id = ? OR s.member_id = ? ORDER BY s.created_at, s.id''', (account.id, account.id)).fetchall()]

    @staticmethod
    def identity(payer_id: str, member_id: str, plan_id: str) -> str:
        return uuid5(NAMESPACE_URL, '/bookiebot/shared-bill/' + '/'.join((payer_id, member_id, plan_id))).hex

    def saved(self, request_id: str, actor: Account, fingerprint: str) -> dict[str, Any] | None:
        with self.access.connect() as db:
            row = db.execute('SELECT * FROM app_bill_share_events WHERE request_id = ?', (request_id,)).fetchone()
            if row is None:
                return None
            if row['actor_id'] != actor.id or row['fingerprint'] != fingerprint:
                raise AccountConflict('This saved sharing request belongs to a different change.')
            return json.loads(row['result'])

    def recover(self, request_id: str, actor: Account) -> dict[str, Any] | None:
        with self.access.connect() as db:
            row = db.execute('SELECT actor_id, result FROM app_bill_share_events WHERE request_id = ?', (request_id,)).fetchone()
            return json.loads(row['result']) if row is not None and row['actor_id'] == actor.id else None

    def apply(self, *, actor: Account, payer: Account, member: Account, plan_id: str,
              member_plan_id: str, action: str, revision: int, request_id: str,
              fingerprint: str, session_token: str | None = None) -> dict[str, Any]:
        identity = self.identity(payer.id, member.id, plan_id)
        with self.access.connect(write=True) as db:
            if isinstance(self.access, PostgresAppAccessStore):
                db.execute('SELECT pg_advisory_xact_lock(84392529)')
            if session_token is not None:
                suffix=' FOR UPDATE' if isinstance(self.access, PostgresAppAccessStore) else ''
                session=db.execute('SELECT * FROM app_phone_sessions WHERE token_hash = ?'+suffix,
                    (hashlib.sha256(session_token.encode()).hexdigest(),)).fetchone()
                if session is None or session['owner_key'] != actor.owner or session['expires_at'] <= int(time.time()):
                    raise AccountConflict('Your app session expired. Reconnect before changing shared access.')
            saved = db.execute('SELECT * FROM app_bill_share_events WHERE request_id = ?', (request_id,)).fetchone()
            if saved is not None:
                if saved['actor_id'] != actor.id or saved['fingerprint'] != fingerprint:
                    raise AccountConflict('This saved sharing request belongs to a different change.')
                return json.loads(saved['result'])
            row = db.execute('SELECT * FROM app_bill_shares WHERE id = ?', (identity,)).fetchone()
            current = dict(row) if row else None
            actual_revision = int(current['revision']) if current else 0
            if actual_revision != revision:
                raise AccountConflict('This bill’s sharing changed. Review the latest version.')
            status = current['status'] if current else None
            if action == 'invite':
                if actor.id != payer.id or payer.id == member.id or status in {'active', 'pending'}:
                    raise AccountConflict('This bill is already shared or waiting for acceptance.')
                next_status = 'pending'
            elif action in {'accept', 'decline'}:
                if actor.id != member.id or status != 'pending':
                    raise AccountConflict('Only the invited person can respond to this bill.')
                next_status = 'active' if action == 'accept' else 'declined'
            elif action == 'stop':
                if actor.id not in {payer.id, member.id} or status not in {'pending', 'active'}:
                    raise AccountConflict('This bill is no longer shared.')
                next_status = 'revoked'
            else:
                raise AccountConflict('Choose a bill-sharing action.')
            if next_status == 'active' and member_plan_id:
                competing = db.execute('''SELECT id FROM app_bill_shares WHERE member_id = ?
                    AND member_plan_id = ? AND status = 'active' AND id <> ?''',
                    (member.id,member_plan_id,identity)).fetchone()
                if competing is not None:
                    raise AccountConflict('A different shared bill already uses this local bill source.')
            now = int(time.time())
            result = {'id': identity, 'status': next_status, 'revision': actual_revision + 1}
            db.execute('''INSERT INTO app_bill_shares
                (id, payer_id, member_id, plan_id, member_plan_id, status, revision, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET
                member_plan_id = excluded.member_plan_id, status = excluded.status,
                revision = excluded.revision, updated_at = excluded.updated_at''',
                (identity, payer.id, member.id, plan_id, member_plan_id, next_status, actual_revision + 1, now, now))
            db.execute('''INSERT INTO app_bill_share_events
                (request_id, actor_id, fingerprint, share_id, action, result, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)''',
                (request_id, actor.id, fingerprint, identity, action, json.dumps(result), now))
            for owner in sorted({payer.owner, member.owner}):
                db.execute('''INSERT INTO app_shared_changes (owner_key, revision) VALUES (?, 1)
                    ON CONFLICT (owner_key) DO UPDATE SET revision = app_shared_changes.revision + 1''', (owner,))
            return result

    def revision(self, owner: str) -> int:
        with self.access.connect() as db:
            row = db.execute('SELECT revision FROM app_shared_changes WHERE owner_key = ?', (owner,)).fetchone()
            return int(row['revision']) if row else 0

    def publish(self, owner: str) -> None:
        """A refresh hint only; a missed hint never controls financial state."""
        with self.access.connect(write=True) as db:
            owners = {owner}
            # The legacy financial adapter already grants this pair their
            # canonical Shared ledger. A cursor contains no bill/amount data and
            # does not grant new membership in anybody's recurring plans.
            from bookiebot.sheets.collaboration import partner_owner_key
            owners.add(partner_owner_key(owner))
            rows = db.execute('''SELECT p.owner_key AS payer, m.owner_key AS member
                FROM app_bill_shares s JOIN app_users p ON s.payer_id = p.user_id
                JOIN app_users m ON s.member_id = m.user_id WHERE s.status = 'active'
                AND (p.owner_key = ? OR m.owner_key = ?)''', (owner, owner)).fetchall()
            owners.update(value for row in rows for value in (row['payer'], row['member']))
            for value in sorted(owners):
                db.execute('''INSERT INTO app_shared_changes (owner_key, revision) VALUES (?, 1)
                    ON CONFLICT (owner_key) DO UPDATE SET revision = app_shared_changes.revision + 1''', (value,))
