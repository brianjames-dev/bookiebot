"""Database-owned budgets for Google-first accounts.

This provider never imports Sheets/Discord routing. Household metadata is shared
by both providers; only managed accounts can use its financial ledger. Managed
identities cannot authenticate to legacy financial APIs. Integer cents,
membership checks, reviewed commands and receipts share one transaction.
"""
from __future__ import annotations

import calendar
from datetime import date, datetime
from functools import lru_cache
import hashlib
import json
import re
import secrets
from typing import Any
from uuid import uuid4
from zoneinfo import ZoneInfo

from bookiebot.reports.accounts import Account, AccountStore, _now
from bookiebot.reports.app_access import AppAccessStore, PostgresAppAccessStore

def now_pacific() -> datetime:
    return datetime.now(ZoneInfo('America/Los_Angeles'))


class BudgetConflict(ValueError):
    pass


def _json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(',', ':'))


def _text(value: Any, label: str, maximum: int = 80) -> str:
    if not isinstance(value, str) or not value.strip() or len(value) > maximum or any(ord(c) < 32 for c in value):
        raise BudgetConflict('Enter a valid ' + label + '.')
    return value.strip()


def _cents(value: Any, *, zero: bool = False) -> int:
    if type(value) is not int or not (0 if zero else 1) <= value <= 100_000_000:
        raise BudgetConflict('Enter an amount between ' + ('$0' if zero else '$0.01') + ' and $1,000,000.')
    return value


def _money(value: int) -> str:
    return f'${value / 100:,.2f}'


def _allocate(total: int, basis: list[int]) -> dict[str, float]:
    pieces = [divmod(total * bps, 10000) for bps in basis]
    amounts = [piece[0] for piece in pieces]
    for i in sorted(range(3), key=lambda i: (-pieces[i][1], i))[:total - sum(amounts)]:
        amounts[i] += 1
    return {key: amount / 100 for key, amount in zip(('needs', 'wants', 'savings'), amounts)}


def _today() -> date:
    return now_pacific().date()


def _month(value: Any) -> str:
    if not isinstance(value, str) or not re.fullmatch(r'20[2-9][0-9]-(0[1-9]|1[0-2])', value):
        raise BudgetConflict('Choose a valid budget month.')
    return value


class ManagedBudgetStore:
    def __init__(self, accounts: AccountStore):
        self.accounts, self.access = accounts, accounts.access

    def initialize(self) -> None:
        with self.access.connect(write=True) as db:
            self._lock(db)
            for sql in (
                '''CREATE TABLE IF NOT EXISTS app_households (
                    id TEXT PRIMARY KEY, name TEXT NOT NULL, creator TEXT NOT NULL,
                    version BIGINT NOT NULL, created_at BIGINT NOT NULL)''',
                '''CREATE TABLE IF NOT EXISTS app_household_members (
                    user_id TEXT PRIMARY KEY, household_id TEXT NOT NULL,
                    role TEXT NOT NULL, joined_at BIGINT NOT NULL)''',
                '''CREATE TABLE IF NOT EXISTS managed_budgets (
                    user_id TEXT PRIMARY KEY, income_cents BIGINT NOT NULL, needs_bps INTEGER NOT NULL,
                    wants_bps INTEGER NOT NULL, savings_bps INTEGER NOT NULL, start_month TEXT NOT NULL,
                    version BIGINT NOT NULL)''',
                '''CREATE TABLE IF NOT EXISTS managed_budget_versions (
                    user_id TEXT NOT NULL, effective_month TEXT NOT NULL, config_json TEXT NOT NULL,
                    PRIMARY KEY(user_id, effective_month))''',
                '''CREATE TABLE IF NOT EXISTS app_household_invites (
                    token_hash TEXT PRIMARY KEY, household_id TEXT NOT NULL, inviter TEXT NOT NULL,
                    expires_at BIGINT NOT NULL, accepted_by TEXT NOT NULL, created_at BIGINT NOT NULL)''',
                '''CREATE TABLE IF NOT EXISTS managed_entries (
                    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, household_id TEXT NOT NULL,
                    version BIGINT NOT NULL, entry_json TEXT NOT NULL, deleted INTEGER NOT NULL,
                    created_at BIGINT NOT NULL)''',
                '''CREATE TABLE IF NOT EXISTS managed_repayments (
                    id TEXT PRIMARY KEY, entry_id TEXT NOT NULL, sender TEXT NOT NULL,
                    receiver TEXT NOT NULL, amount_cents BIGINT NOT NULL, status TEXT NOT NULL,
                    created_at BIGINT NOT NULL, confirmed_at BIGINT NOT NULL)''',
                '''CREATE TABLE IF NOT EXISTS managed_goals (
                    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL,
                    target_cents BIGINT NOT NULL)''',
                '''CREATE TABLE IF NOT EXISTS managed_reviews (
                    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, request_id TEXT NOT NULL,
                    fingerprint TEXT NOT NULL, command_json TEXT NOT NULL, version TEXT NOT NULL,
                    review_json TEXT NOT NULL, expires_at BIGINT NOT NULL, result_json TEXT NOT NULL,
                    UNIQUE(user_id, request_id))''',
                '''CREATE TABLE IF NOT EXISTS app_household_reviews (
                    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, request_id TEXT NOT NULL,
                    fingerprint TEXT NOT NULL, command_json TEXT NOT NULL, review_json TEXT NOT NULL,
                    expires_at BIGINT NOT NULL, result_json TEXT NOT NULL,
                    UNIQUE(user_id, request_id))''',
                'CREATE INDEX IF NOT EXISTS managed_entries_household ON managed_entries(household_id)',
                'CREATE INDEX IF NOT EXISTS managed_repayments_entry ON managed_repayments(entry_id)',
            ):
                db.execute(sql)

    def _lock(self, db: Any) -> None:
        if isinstance(self.access, PostgresAppAccessStore):
            db.execute('SELECT pg_advisory_xact_lock(84392528)')

    def _identity(self, db: Any, account: Account) -> None:
        row = db.execute('SELECT * FROM app_users WHERE user_id = ?', (account.id,)).fetchone()
        if row is None or row['owner_key'] != account.owner or row['actor_key'] != account.actor:
            raise BudgetConflict('This account is unavailable.')

    def _account(self, db: Any, account: Account) -> None:
        self._identity(db, account)
        if (account.owner != 'managed:' + account.id
                or account.actor != 'app:' + account.id):
            raise BudgetConflict('This budget uses the existing connected workbook.')

    def _session_proof(self, db: Any, account: Account, token: str | None) -> None:
        if token is None:  # Direct domain calls in isolated tests, never HTTP.
            return
        lock = ' FOR UPDATE' if isinstance(self.access, PostgresAppAccessStore) else ''
        row = db.execute('SELECT * FROM app_phone_sessions WHERE token_hash = ?' + lock,
                         (hashlib.sha256(token.encode()).hexdigest(),)).fetchone()
        if row is None or row['expires_at'] <= _now() or row['owner_key'] != account.owner or row['actor_key'] != account.actor:
            raise BudgetConflict('Your session changed. Sign in again.')

    def _member(self, db: Any, account: Account):
        return db.execute('''SELECT m.*, h.name, h.version FROM app_household_members m
            JOIN app_households h ON h.id = m.household_id WHERE m.user_id = ?''', (account.id,)).fetchone()

    def _members(self, db: Any, household: str) -> list[dict[str, Any]]:
        return [dict(row) for row in db.execute('''SELECT u.user_id AS id, u.display_name AS name, m.role,
            CASE WHEN substr(u.owner_key, 1, 8) = 'managed:' THEN 'managed' ELSE 'sheets' END AS provider
            FROM app_household_members m JOIN app_users u ON u.user_id = m.user_id
            WHERE m.household_id = ? ORDER BY CASE WHEN m.role = 'owner' THEN 0 ELSE 1 END, m.joined_at, u.user_id''', (household,)).fetchall()]

    def _version(self, db: Any, account: Account) -> str:
        member = self._member(db, account)
        budget = db.execute('SELECT version FROM managed_budgets WHERE user_id = ?', (account.id,)).fetchone()
        return f"{member['household_id']}:{member['version']}:{budget['version']}" if member and budget else 'new'

    def bootstrap(self, account: Account) -> dict[str, Any]:
        with self.access.connect() as db:
            self._account(db, account)
            member = self._member(db, account)
            budget = db.execute('SELECT * FROM managed_budgets WHERE user_id = ?', (account.id,)).fetchone()
            return {'phase': 'ready' if member and budget else 'onboarding', 'provider': 'managed',
                    'account': {'id': account.id, 'name': account.name},
                    'household': {'id': member['household_id'], 'name': member['name']} if member else None}

    def _invite(self, db: Any, token_hash: str):
        row = db.execute('''SELECT i.*, h.name FROM app_household_invites i
            JOIN app_households h ON h.id = i.household_id WHERE i.token_hash = ?''', (token_hash,)).fetchone()
        if row is None or row['expires_at'] <= _now() or row['accepted_by']:
            raise BudgetConflict('This invitation expired or was used. Ask for a new invitation.')
        if len(self._members(db, row['household_id'])) >= 6:
            raise BudgetConflict('This household is full (six members).')
        return row

    def issue_invite(self, account: Account, *, session_token: str | None = None) -> dict[str, Any]:
        with self.access.connect(write=True) as db:
            self._lock(db)
            self._identity(db, account)
            self._session_proof(db, account, session_token)
            member = self._member(db, account)
            if member is None or member['role'] != 'owner':
                raise BudgetConflict('Only the household creator can invite members.')
            if len(self._members(db, member['household_id'])) >= 6:
                raise BudgetConflict('This household is full (six members).')
            token = secrets.token_urlsafe(32)
            # One active invitation. Reissuing also revokes a lost link. Only
            # hashes persist; a lost response cannot expose/replay raw tokens.
            db.execute("DELETE FROM app_household_invites WHERE inviter = ? AND accepted_by = ''", (account.id,))
            db.execute('''INSERT INTO app_household_invites VALUES (?, ?, ?, ?, '', ?)''',
                       (hashlib.sha256(token.encode()).hexdigest(), member['household_id'], account.id, _now() + 7 * 86400, _now()))
            return {'token': token, 'expiresInDays': 7}

    def household(self, account: Account) -> dict[str, Any]:
        with self.access.connect() as db:
            self._identity(db, account)
            member = self._member(db, account)
            return {'account': {'id': account.id, 'name': account.name},
                'provider': 'managed' if account.owner.startswith('managed:') else 'sheets',
                'household': {'name': member['name'], 'role': member['role'],
                    'members': self._members(db, member['household_id'])} if member else None}

    def household_review(self, account: Account, body: dict[str, Any], *, session_token: str) -> dict[str, Any]:
        request_id = body.get('requestId')
        if not isinstance(request_id, str) or not re.fullmatch(r'[a-f0-9-]{32,36}', request_id):
            raise BudgetConflict('Refresh this form before reviewing.')
        fingerprint = hashlib.sha256(_json(body).encode()).hexdigest()
        with self.access.connect(write=True) as db:
            self._lock(db)
            self._identity(db, account)
            self._session_proof(db, account, session_token)
            prior = db.execute('SELECT * FROM app_household_reviews WHERE user_id = ? AND request_id = ?', (account.id, request_id)).fetchone()
            if prior:
                if prior['fingerprint'] != fingerprint:
                    raise BudgetConflict('This review belongs to a different change.')
                if prior['result_json']:
                    return json.loads(prior['result_json'])
                if prior['expires_at'] <= _now():
                    raise BudgetConflict('This review expired. Review again.')
                return json.loads(prior['review_json'])
            if self._member(db, account):
                raise BudgetConflict('You already belong to a household.')
            if account.owner.startswith('managed:'):
                raise BudgetConflict('Create or join a household during your budget setup.')
            operation = body.get('operation')
            if operation == 'create':
                name = _text(body.get('name'), 'household name', 60)
                value = {'operation': 'create', 'name': name}
                items = [{'label': 'Create household', 'value': name}]
            elif operation == 'join':
                token = body.get('invite')
                if not isinstance(token, str) or not re.fullmatch(r'[A-Za-z0-9_-]{43}', token):
                    raise BudgetConflict('Paste a valid household invitation.')
                digest = hashlib.sha256(token.encode()).hexdigest()
                invite = self._invite(db, digest)
                value = {'operation': 'join', 'inviteHash': digest}
                items = [{'label': 'Join household', 'value': invite['name']},
                         {'label': 'Members', 'value': ', '.join(m['name'] for m in self._members(db, invite['household_id']))}]
            else:
                raise BudgetConflict('Choose create or join household.')
            items.append({'label': 'Your budget', 'value': 'Keep the existing connected workbook and all financial history.'})
            review = {'reviewId': uuid4().hex, 'title': 'Review household', 'items': items}
            db.execute("DELETE FROM app_household_reviews WHERE user_id = ? AND expires_at <= ? AND result_json = ''", (account.id, _now()))
            if db.execute("SELECT COUNT(*) AS n FROM app_household_reviews WHERE user_id = ? AND result_json = ''", (account.id,)).fetchone()['n'] >= 50:
                raise BudgetConflict('Too many open reviews. Try again shortly.')
            db.execute('INSERT INTO app_household_reviews VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
                       (review['reviewId'], account.id, request_id, fingerprint, _json(value), _json(review), _now() + 600, ''))
            return review

    def household_recover(self, account: Account, identity: str) -> dict[str, Any]:
        with self.access.connect() as db:
            self._identity(db, account)
            row = db.execute('SELECT * FROM app_household_reviews WHERE id = ? AND user_id = ?', (identity, account.id)).fetchone()
            if row is None:
                raise BudgetConflict('This review is unavailable.')
            return json.loads(row['result_json']) if row['result_json'] else {'expired': True} if row['expires_at'] <= _now() else json.loads(row['review_json'])

    def household_confirm(self, account: Account, identity: str, *, session_token: str) -> dict[str, Any]:
        with self.access.connect(write=True) as db:
            self._lock(db)
            self._identity(db, account)
            self._session_proof(db, account, session_token)
            row = db.execute('SELECT * FROM app_household_reviews WHERE id = ? AND user_id = ?', (identity, account.id)).fetchone()
            if row is None:
                raise BudgetConflict('This review is unavailable.')
            if row['result_json']:
                return json.loads(row['result_json'])
            if row['expires_at'] <= _now() or self._member(db, account):
                raise BudgetConflict('This review expired or your household changed. Review again.')
            value = json.loads(row['command_json'])
            if value['operation'] == 'create':
                household, role = uuid4().hex, 'owner'
                db.execute('INSERT INTO app_households VALUES (?, ?, ?, 0, ?)', (household, value['name'], account.id, _now()))
            else:
                invite = self._invite(db, value['inviteHash'])
                household, role = invite['household_id'], 'member'
                db.execute('UPDATE app_household_invites SET accepted_by = ? WHERE token_hash = ?', (account.id, value['inviteHash']))
            db.execute('INSERT INTO app_household_members VALUES (?, ?, ?, ?)', (account.id, household, role, _now()))
            db.execute('UPDATE app_households SET version = version + 1 WHERE id = ?', (household,))
            result = {'completed': True, 'operation': value['operation']}
            db.execute('UPDATE app_household_reviews SET result_json = ? WHERE id = ?', (_json(result), identity))
            return result

    def _entries(self, db: Any, account: Account, household: str) -> list[dict[str, Any]]:
        result = []
        for row in db.execute('SELECT * FROM managed_entries WHERE household_id = ? AND deleted = 0 ORDER BY created_at, id', (household,)).fetchall():
            entry = json.loads(row['entry_json'])
            if row['user_id'] == account.id or account.id in entry.get('shares', {}):
                result.append({**entry, 'id': row['id'], 'owner': row['user_id'], 'version': row['version']})
        return result

    def _repayments(self, db: Any, entry_id: str) -> list[dict[str, Any]]:
        return [dict(r) for r in db.execute('SELECT * FROM managed_repayments WHERE entry_id = ? ORDER BY created_at, id', (entry_id,)).fetchall()]

    def _entry(self, db: Any, account: Account, identity: Any):
        row = db.execute('SELECT * FROM managed_entries WHERE id = ? AND deleted = 0', (identity,)).fetchone()
        member = self._member(db, account)
        if row is None or member is None or row['household_id'] != member['household_id']:
            raise BudgetConflict('This transaction is unavailable.')
        return row, json.loads(row['entry_json'])

    def _normalize(self, db: Any, account: Account, body: dict[str, Any]) -> tuple[dict[str, Any], list[dict[str, str]]]:
        op = body.get('operation')
        if op not in {'setup', 'budget', 'add', 'edit', 'delete', 'repay', 'confirm-repayment', 'remove-repayment', 'goal'}:
            raise BudgetConflict('Choose a valid action.')
        member = self._member(db, account)
        summary: list[dict[str, str]] = []
        if op in {'setup', 'budget'}:
            if op == 'setup' and member is not None:
                raise BudgetConflict('Your budget is already set up.')
            if op == 'budget' and member is None:
                raise BudgetConflict('Finish budget setup first.')
            name = _text(body.get('name'), 'name', 60)
            income = _cents(body.get('incomeCents'), zero=True)
            allocation = body.get('allocation')
            if (not isinstance(allocation, list) or len(allocation) != 3 or
                    any(type(x) is not int or not 0 <= x <= 10000 for x in allocation) or sum(allocation) != 10000):
                raise BudgetConflict('Needs, Wants and Savings must total 100%.')
            start = _month(body.get('startMonth'))
            if start > _today().strftime('%Y-%m'):
                raise BudgetConflict('Start your budget this month or earlier.')
            if op == 'budget':
                previous = db.execute('SELECT start_month FROM managed_budgets WHERE user_id = ?', (account.id,)).fetchone()
                if start != previous['start_month']:
                    raise BudgetConflict('Keep the original budget start month to preserve your history.')
            value = {'operation': op, 'name': name, 'incomeCents': income, 'allocation': allocation, 'startMonth': start}
            if op == 'setup':
                token = body.get('invite', '')
                if token:
                    if not isinstance(token, str) or not re.fullmatch(r'[A-Za-z0-9_-]{43}', token):
                        raise BudgetConflict('Paste a valid household invitation.')
                    digest = hashlib.sha256(token.encode()).hexdigest()
                    invite = self._invite(db, digest)
                    value['inviteHash'] = digest
                    value['householdName'] = invite['name']
                    summary.append({'label': 'Join household', 'value': invite['name']})
                else:
                    value['householdName'] = _text(body.get('householdName'), 'household name', 60)
                    summary.append({'label': 'Create household', 'value': value['householdName']})
            summary.extend([{'label': 'Name', 'value': name}, {'label': 'Expected monthly take-home', 'value': _money(income)},
                {'label': 'Needs / Wants / Savings', 'value': ' / '.join(f'{x / 100:g}%' for x in allocation)},
                {'label': 'Budget starts', 'value': start}, {'label': 'Currency / calendar', 'value': 'USD · Pacific time'}])
            if op == 'budget':
                summary.append({'label': 'Applies', 'value': 'This month onward. Earlier budget settings stay unchanged.'})
            return value, summary
        if member is None:
            raise BudgetConflict('Finish budget setup first.')
        if op == 'goal':
            name, target = _text(body.get('name'), 'goal name'), _cents(body.get('targetCents'))
            return {'operation': op, 'name': name, 'targetCents': target}, [{'label': 'Savings goal', 'value': name}, {'label': 'Target', 'value': _money(target)}]
        if op in {'repay', 'confirm-repayment', 'remove-repayment'}:
            row, entry = self._entry(db, account, body.get('entryId'))
            payments = self._repayments(db, row['id'])
            if op == 'repay':
                if account.id == row['user_id'] or account.id not in entry['shares']:
                    raise BudgetConflict('Only a person with a share can report their repayment.')
                amount = _cents(body.get('amountCents'))
                reserved = sum(p['amount_cents'] for p in payments if p['sender'] == account.id and p['status'] in {'pending', 'confirmed'})
                if amount > entry['shares'][account.id] - reserved:
                    raise BudgetConflict('The amount exceeds the remaining unreported share.')
                value = {'operation': op, 'entryId': row['id'], 'amountCents': amount}
                return value, [{'label': 'Report repayment', 'value': _money(amount)}, {'label': 'For', 'value': entry['name']}, {'label': 'Next', 'value': 'The payer must confirm receiving it.'}]
            receipt = next((p for p in payments if p['id'] == body.get('repaymentId')), None)
            if op == 'remove-repayment':
                if receipt is None or receipt['status'] != 'pending' or account.id not in {receipt['sender'], receipt['receiver']}:
                    raise BudgetConflict('Only its sender or payer can dismiss a pending repayment.')
                return {'operation': op, 'entryId': row['id'], 'repaymentId': receipt['id']}, [
                    {'label': 'Dismiss repayment report', 'value': _money(receipt['amount_cents'])},
                    {'label': 'For', 'value': entry['name']}, {'label': 'Effect', 'value': 'No confirmed payment changes. The share is still owed.'}]
            if row['user_id'] != account.id or receipt is None or receipt['status'] != 'pending':
                raise BudgetConflict('Only the payer can confirm this pending repayment.')
            return {'operation': op, 'entryId': row['id'], 'repaymentId': receipt['id']}, [
                {'label': 'Confirm money received', 'value': _money(receipt['amount_cents'])}, {'label': 'For', 'value': entry['name']}]
        old = None
        if op in {'edit', 'delete'}:
            old, _ = self._entry(db, account, body.get('entryId'))
            if old['user_id'] != account.id:
                raise BudgetConflict('Only the transaction creator can edit it.')
            if old['version'] != body.get('version'):
                raise BudgetConflict('This transaction changed. Refresh and review it again.')
            if any(p['status'] in {'pending', 'confirmed'} for p in self._repayments(db, old['id'])):
                raise BudgetConflict('This shared transaction has a repayment. Keep its original record.')
            if op == 'delete':
                entry = json.loads(old['entry_json'])
                return {'operation': op, 'entryId': old['id'], 'version': old['version']}, [
                    {'label': 'Delete transaction', 'value': entry['name']}, {'label': 'Amount', 'value': _money(entry['amountCents'])}]
        kind = body.get('kind')
        category = body.get('category')
        if kind not in {'expense', 'income', 'transfer'} or (kind == 'expense' and category not in {'needs', 'wants'}):
            raise BudgetConflict('Choose an expense, income or savings transfer.')
        name, amount = _text(body.get('name'), 'transaction name'), _cents(body.get('amountCents'))
        try:
            when = date.fromisoformat(body.get('date', ''))
        except (TypeError, ValueError) as exc:
            raise BudgetConflict('Choose a valid transaction date.') from exc
        budget = db.execute('SELECT start_month FROM managed_budgets WHERE user_id = ?', (account.id,)).fetchone()
        if budget is None or when > _today() or when.strftime('%Y-%m') < budget['start_month']:
            raise BudgetConflict('Choose an actual date within your budget history, through today.')
        shares = {account.id: amount}
        split = body.get('split', False)
        if type(split) is not bool:
            raise BudgetConflict('Choose whether to share this expense.')
        if split:
            household_members = self._members(db, member['household_id'])
            if any(m['provider'] != 'managed' for m in household_members):
                raise BudgetConflict('Connected workbook members manage shared bills in their existing Bills and Shared screens. This transaction cannot create a separate shared ledger for them.')
            members = sorted(m['id'] for m in household_members)
            if kind != 'expense' or len(members) < 2:
                raise BudgetConflict('Invite a household member before splitting expenses.')
            shares = {identity: amount // len(members) + (1 if i < amount % len(members) else 0) for i, identity in enumerate(members)}
        goal = body.get('goalId', '')
        if not isinstance(goal, str):
            raise BudgetConflict('Choose a savings goal.')
        if goal and (kind != 'transfer' or db.execute('SELECT id FROM managed_goals WHERE id = ? AND user_id = ?', (goal, account.id)).fetchone() is None):
            raise BudgetConflict('Choose one of your savings goals.')
        value = {'operation': op, 'kind': kind, 'name': name, 'amountCents': amount, 'date': when.isoformat(),
                 'category': category if kind == 'expense' else kind, 'shares': shares, 'split': split, 'goalId': goal}
        if old:
            value.update(entryId=old['id'], version=old['version'])
        summary = [{'label': 'Transaction', 'value': name}, {'label': 'Amount', 'value': _money(amount)},
                   {'label': 'Date', 'value': when.isoformat()}, {'label': 'Type', 'value': 'Savings transfer' if kind == 'transfer' else str(value['category']).title()},
                   {'label': 'Shared', 'value': f'Equally between {len(shares)} members' if split else 'Only you'}]
        if goal:
            summary.append({'label': 'Savings goal', 'value': db.execute('SELECT name FROM managed_goals WHERE id = ?', (goal,)).fetchone()['name']})
        return value, summary

    def prepare(self, account: Account, body: dict[str, Any], *, session_token: str | None = None) -> dict[str, Any]:
        request = body.get('requestId')
        if not isinstance(request, str) or not re.fullmatch(r'[a-f0-9-]{32,36}', request):
            raise BudgetConflict('Refresh this form before reviewing.')
        fingerprint = hashlib.sha256(_json(body).encode()).hexdigest()
        with self.access.connect(write=True) as db:
            self._lock(db)
            self._account(db, account)
            self._session_proof(db, account, session_token)
            prior = db.execute('SELECT * FROM managed_reviews WHERE user_id = ? AND request_id = ?', (account.id, request)).fetchone()
            if prior:
                if prior['fingerprint'] != fingerprint:
                    raise BudgetConflict('This review belongs to a different change.')
                if prior['result_json']:
                    return {'completed': True, **json.loads(prior['result_json'])}
                if prior['expires_at'] <= _now():
                    raise BudgetConflict('This review expired. Return and review the change again.')
                return json.loads(prior['review_json'])
            normalized, summary = self._normalize(db, account, body)
            db.execute("DELETE FROM managed_reviews WHERE user_id = ? AND expires_at <= ? AND result_json = ''", (account.id, _now()))
            if db.execute("SELECT COUNT(*) AS n FROM managed_reviews WHERE user_id = ? AND result_json = ''", (account.id,)).fetchone()['n'] >= 50:
                raise BudgetConflict('Too many open reviews. Try again in a few minutes.')
            review = {'reviewId': uuid4().hex, 'title': 'Review budget' if body['operation'] in {'setup', 'budget'} else 'Review change', 'items': summary}
            db.execute('INSERT INTO managed_reviews VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
                (review['reviewId'], account.id, request, fingerprint, _json(normalized), self._version(db, account), _json(review), _now() + 600, ''))
            return review

    def recover(self, account: Account, identity: str) -> dict[str, Any]:
        with self.access.connect() as db:
            self._account(db, account)
            row = db.execute('SELECT * FROM managed_reviews WHERE user_id = ? AND id = ?', (account.id, identity)).fetchone()
            if row is None:
                raise BudgetConflict('This review is unavailable.')
            if row['result_json']:
                return json.loads(row['result_json'])
            if row['expires_at'] <= _now():
                return {'expired': True}
            return json.loads(row['review_json'])

    def confirm(self, account: Account, review_id: str, *, session_token: str | None = None) -> dict[str, Any]:
        with self.access.connect(write=True) as db:
            self._lock(db)
            self._account(db, account)
            self._session_proof(db, account, session_token)
            row = db.execute('SELECT * FROM managed_reviews WHERE id = ? AND user_id = ?', (review_id, account.id)).fetchone()
            if row is None:
                raise BudgetConflict('This review is unavailable.')
            if row['result_json']:
                return json.loads(row['result_json'])
            if row['expires_at'] <= _now() or row['version'] != self._version(db, account):
                raise BudgetConflict('The budget changed or this review expired. Return and review again.')
            value = json.loads(row['command_json'])
            op = value['operation']
            result: dict[str, Any] = {'completed': True, 'operation': op}
            if op in {'setup', 'budget'}:
                if op == 'setup':
                    if value.get('inviteHash'):
                        invite = self._invite(db, value['inviteHash'])
                        household = invite['household_id']
                        db.execute('UPDATE app_household_invites SET accepted_by = ? WHERE token_hash = ?', (account.id, value['inviteHash']))
                        role = 'member'
                    else:
                        household, role = uuid4().hex, 'owner'
                        db.execute('INSERT INTO app_households VALUES (?, ?, ?, 0, ?)', (household, value['householdName'], account.id, _now()))
                    db.execute('INSERT INTO app_household_members VALUES (?, ?, ?, ?)', (account.id, household, role, _now()))
                needs, wants, savings = value['allocation']
                db.execute('''INSERT INTO managed_budgets VALUES (?, ?, ?, ?, ?, ?, 1)
                    ON CONFLICT(user_id) DO UPDATE SET income_cents = excluded.income_cents,
                    needs_bps = excluded.needs_bps, wants_bps = excluded.wants_bps, savings_bps = excluded.savings_bps,
                    start_month = excluded.start_month, version = managed_budgets.version + 1''',
                    (account.id, value['incomeCents'], needs, wants, savings, value['startMonth']))
                db.execute('UPDATE app_users SET display_name = ? WHERE user_id = ?', (value['name'], account.id))
                effective = value['startMonth'] if op == 'setup' else _today().strftime('%Y-%m')
                db.execute('''INSERT INTO managed_budget_versions VALUES (?, ?, ?)
                    ON CONFLICT(user_id, effective_month) DO UPDATE SET config_json = excluded.config_json''',
                           (account.id, effective, _json({'incomeCents': value['incomeCents'], 'allocation': value['allocation']})))
            elif op == 'goal':
                result['goalId'] = uuid4().hex
                db.execute('INSERT INTO managed_goals VALUES (?, ?, ?, ?)', (result['goalId'], account.id, value['name'], value['targetCents']))
            elif op in {'add', 'edit'}:
                if op == 'add':
                    member = self._member(db, account)
                    result['entryId'] = uuid4().hex
                    db.execute('INSERT INTO managed_entries VALUES (?, ?, ?, 1, ?, 0, ?)',
                               (result['entryId'], account.id, member['household_id'], _json(value), _now()))
                else:
                    result['entryId'] = value['entryId']
                    db.execute('UPDATE managed_entries SET entry_json = ?, version = version + 1 WHERE id = ?', (_json(value), value['entryId']))
            elif op == 'delete':
                result['entryId'] = value['entryId']
                db.execute('UPDATE managed_entries SET deleted = 1, version = version + 1 WHERE id = ?', (value['entryId'],))
            elif op == 'repay':
                entry, _ = self._entry(db, account, value['entryId'])
                result.update(entryId=value['entryId'], repaymentId=uuid4().hex)
                db.execute("INSERT INTO managed_repayments VALUES (?, ?, ?, ?, ?, 'pending', ?, 0)",
                           (result['repaymentId'], value['entryId'], account.id, entry['user_id'], value['amountCents'], _now()))
            elif op == 'confirm-repayment':
                result.update(entryId=value['entryId'], repaymentId=value['repaymentId'])
                db.execute("UPDATE managed_repayments SET status = 'confirmed', confirmed_at = ? WHERE id = ?", (_now(), value['repaymentId']))
            elif op == 'remove-repayment':
                result.update(entryId=value['entryId'], repaymentId=value['repaymentId'])
                db.execute("UPDATE managed_repayments SET status = 'rejected' WHERE id = ?", (value['repaymentId'],))
            member = self._member(db, account)
            db.execute('UPDATE app_households SET version = version + 1 WHERE id = ?', (member['household_id'],))
            db.execute('UPDATE managed_reviews SET result_json = ? WHERE id = ?', (_json(result), review_id))
            return result

    def state(self, account: Account, month: str) -> dict[str, Any]:
        month = _month(month)
        with self.access.connect() as db:
            self._account(db, account)
            member = self._member(db, account)
            budget = db.execute('SELECT * FROM managed_budgets WHERE user_id = ?', (account.id,)).fetchone()
            if member is None or budget is None:
                raise BudgetConflict('Finish budget setup first.')
            if month < budget['start_month'] or month > _today().strftime('%Y-%m'):
                raise BudgetConflict('Choose a month within your budget history.')
            members = self._members(db, member['household_id'])
            names = {m['id']: m['name'] for m in members}
            entries = self._entries(db, account, member['household_id'])
            visible, shared = [], []
            goals = [dict(r) for r in db.execute('SELECT * FROM managed_goals WHERE user_id = ? ORDER BY name, id', (account.id,)).fetchall()]
            savings = {g['id']: 0 for g in goals}
            for entry in entries:
                payments = self._repayments(db, entry['id'])
                confirmed = sum(p['amount_cents'] for p in payments if p['status'] == 'confirmed')
                if entry['owner'] == account.id:
                    cash = entry['amountCents'] - confirmed
                else:
                    cash = sum(p['amount_cents'] for p in payments if p['status'] == 'confirmed' and p['sender'] == account.id)
                entry = {**entry, 'personalAmountCents': cash, 'payerName': names.get(entry['owner'], 'Former member')}
                if entry['split']:
                    own_confirmed = sum(p['amount_cents'] for p in payments if p['status'] == 'confirmed' and p['sender'] == account.id)
                    own_pending = sum(p['amount_cents'] for p in payments if p['status'] == 'pending' and p['sender'] == account.id)
                    due = entry['amountCents'] - entry['shares'][account.id] - confirmed if entry['owner'] == account.id else entry['shares'][account.id] - own_confirmed
                    shared.append({**entry, 'outstandingCents': due, 'pendingCents': own_pending, 'repayments': [
                        {**p, 'senderName': names.get(p['sender'], 'Former member')} for p in payments if entry['owner'] == account.id or p['sender'] == account.id]})
                if entry['kind'] == 'transfer' and entry['owner'] == account.id and entry['goalId'] in savings:
                    savings[entry['goalId']] += cash
                if entry['date'].startswith(month):
                    visible.append(entry)
            for goal in goals:
                goal['saved_cents'] = savings[goal['id']]
            budget_data = {'name': names[account.id], 'incomeCents': budget['income_cents'],
                'allocation': [budget['needs_bps'], budget['wants_bps'], budget['savings_bps']], 'startMonth': budget['start_month']}
            version = db.execute('''SELECT config_json FROM managed_budget_versions
                WHERE user_id = ? AND effective_month <= ? ORDER BY effective_month DESC LIMIT 1''', (account.id, month)).fetchone()
            report_budget = {**budget_data, **json.loads(version['config_json'])} if version else budget_data
            report = managed_report(report_budget, visible, month)
            report['sharedReimbursements'] = [{
                'id': e['id'], 'date': e['date'], 'item': e['name'], 'location': '',
                'payer': e['payerName'], 'partner': ', '.join(names.get(i, 'Former member') for i in e['shares'] if i != e['owner']),
                'responsibleOwner': account.owner, 'responsiblePerson': names[account.id],
                'grossAmount': e['amountCents'] / 100, 'personalShare': e['shares'][account.id] / 100,
                'partnerShare': (e['amountCents'] - e['shares'][account.id]) / 100,
                'receivedAmount': sum(p['amount_cents'] for p in e['repayments'] if p['status'] == 'confirmed') / 100,
                'outstandingAmount': e['outstandingCents'] / 100,
                'status': 'outstanding' if e['outstandingCents'] else 'reimbursed',
            } for e in shared if e['date'].startswith(month)]
            return {'account': {'id': account.id, 'name': names[account.id]}, 'household': {'name': member['name'], 'members': members, 'role': member['role']},
                'budget': budget_data, 'month': month, 'version': self._version(db, account),
                'entries': sorted(visible, key=lambda e: (e['date'], e['id']), reverse=True),
                'shared': shared, 'goals': goals, 'report': report}


def managed_report(budget: dict[str, Any], entries: list[dict[str, Any]], month: str) -> dict[str, Any]:
    """The existing Overview component consumes this database-only projection."""
    year, number = map(int, month.split('-'))
    days = calendar.monthrange(year, number)[1]
    elapsed = min(days, _today().day) if month == _today().strftime('%Y-%m') else days if month < _today().strftime('%Y-%m') else 0
    totals = {kind: sum(e['personalAmountCents'] for e in entries if e['kind'] == kind) / 100 for kind in ('expense', 'income', 'transfer')}
    category = {key: sum(e['personalAmountCents'] for e in entries if e['kind'] == 'expense' and e['category'] == key) / 100 for key in ('needs', 'wants')}
    category['savings'] = totals['transfer']
    income = totals['income']
    projected = max(income, budget['incomeCents'] / 100)
    budgets = {key: budget['incomeCents'] * bps / 1_000_000 for key, bps in zip(('needs', 'wants', 'savings'), budget['allocation'])}
    spent, saved = totals['expense'], totals['transfer']
    metrics = {'totalExpenses': spent, 'sharedExpenses': 0, 'personalOutflows': spent, 'fixedCommitments': 0,
               'monthlyIncome': income, 'remainingBudget': income - spent - saved,
               'remainingNeedsBudget': budgets['needs'] - category['needs'], 'remainingWantsBudget': budgets['wants'] - category['wants'],
               'remainingSavingsBudget': budgets['savings'] - saved, 'needsRollover': 0, 'wantsRollover': 0,
               'amountSaved': saved, 'savingsGoal': budgets['savings'], 'incomeAfterExpenses': income - spent}
    breakdown = [{'key': key, 'label': key.title(), 'amount': value, 'percentage': value / max(1, spent + saved) * 100, 'color': color}
                 for (key, value), color in zip(category.items(), ('#93bfae', '#cc9d71', '#cbb470')) if value]
    daily = [{'date': e['date'], 'category': e['category'].title(), 'amount': e['personalAmountCents'] / 100,
              'person': budget['name'], 'item': e['name'], 'location': ''} for e in entries if e['kind'] == 'expense']
    report = {'ownerName': budget['name'], 'monthLabel': date(year, number, 1).strftime('%B %Y'), 'year': year, 'month': number,
        'daysInMonth': days, 'elapsedDays': elapsed, 'generatedAt': now_pacific().isoformat(), 'metrics': metrics,
        'incomeProjection': {'currentAmount': income, 'projectedAmount': projected, 'savingsGoal': budgets['savings']},
        'savingsProjection': {'currentAmount': saved, 'projectedAmount': saved, 'currentIdeal': budgets['savings'], 'currentMinimum': budgets['savings'],
                             'projectedIdeal': budgets['savings'], 'projectedMinimum': budgets['savings']},
        'burnRate': None, 'breakdown': breakdown, 'budgetBreakdown': breakdown, 'categoryBudgets': budgets, 'categorySpending': category,
        'dailyTotals': [{'label': str(day), 'amount': sum(e['amount'] for e in daily if int(e['date'][-2:]) == day)} for day in range(1, days + 1)],
        'budgetGroups': [], 'personTotals': [], 'merchantTotals': [], 'merchantOccurrences': [], 'topEntries': daily[:10], 'dailyEntries': daily,
        'needExpenses': [], 'calendarEvents': [{'kind': 'transfer' if e['kind'] == 'transfer' else 'income' if e['kind'] == 'income' else 'bill',
             'label': e['name'], 'amount': e['personalAmountCents'] / 100, 'day': int(e['date'][-2:]), 'group': e['category'].title(), 'projectedOnly': False} for e in entries if e['kind'] != 'expense'],
        'utilityHistory': [], 'sharedReimbursements': [], 'subscriptionsNeeds': [], 'subscriptionsWants': []}
    # Publish explicit mode views: the legacy frontend fallback assumes 50/30/20
    # and treats every breakdown item as spend. Managed allocations are chosen
    # by the user, and savings must never be included in Spent.
    views = {}
    for mode, amount in [('current', income), ('projected', projected)]:
        allocations = _allocate(round(amount * 100), budget['allocation'])
        raw = {key: round(allocations[key] - category[key], 2) for key in allocations}
        chart = [{'key': key, 'label': label, 'amount': value, 'percentage': value / max(amount, spent + saved, 1) * 100, 'color': color}
                 for key, label, value, color in [('need_expenses', 'Needs', category['needs'], '#93bfae'), ('shopping', 'Wants', category['wants'], '#cc9d71'),
                     ('savings_transfers', 'Savings transfers', saved, '#cbb470'), ('left', 'Left', max(0, amount - spent - saved), '#a1aaa6')] if value]
        views[mode] = {'metrics': {'totalExpenses': spent, 'monthlyIncome': amount, 'incomeAfterExpenses': round(amount - spent - saved, 2),
            'amountSaved': saved, 'savingsIdeal': allocations['savings'], 'savingsMinimum': allocations['savings']},
            'categoryBalances': {'raw': raw, 'remaining': {key: max(0, value) for key, value in raw.items()},
                'deficits': {key: max(0, -value) for key, value in raw.items()}, 'transfers': [], 'totalOverspend': sum(max(0, -value) for value in raw.values())},
            'categoryBudgets': allocations, 'categorySpending': category, 'breakdown': chart, 'burnRate': None,
            'calendarEvents': report['calendarEvents'], 'utilityHistory': []}
    report['modeViews'] = views
    return report


@lru_cache(maxsize=8)
def managed_store(accounts: AccountStore) -> ManagedBudgetStore:
    store = ManagedBudgetStore(accounts)
    store.initialize()
    return store
