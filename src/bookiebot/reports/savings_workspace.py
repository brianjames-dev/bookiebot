"""Recorded cash accounts and goal envelopes. No bank, expense or sheet writes."""
from __future__ import annotations

from collections import defaultdict
from contextlib import nullcontext
import hashlib
import json
import re
from typing import Any
from uuid import uuid4

from bookiebot.reports.goals_store import GoalsStore, GoalConflictError, GoalValidationError, _cents, _text

ICONS = {'target', 'shield', 'plane', 'house', 'laptop', 'piggy'}
# Preserve allocations already recorded when this workspace was introduced.
LEGACY_ALLOCATION_THROUGH = '2026-11-18'
INSTITUTIONS = {'other', 'ally', 'chase', 'boa', 'capital-one', 'wells-fargo', 'citi', 'discover', 'sofi', 'usbank', 'pnc', 'amex', 'fidelity', 'schwab', 'vanguard'}


def initialize(db: Any) -> None:
    db.execute('''CREATE TABLE IF NOT EXISTS app_savings_profiles (
        owner_key TEXT PRIMARY KEY, revision BIGINT NOT NULL, frozen_json TEXT NOT NULL)''')
    db.execute('''CREATE TABLE IF NOT EXISTS app_savings_accounts (
        owner_key TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL, institution_id TEXT NOT NULL,
        opening_cents BIGINT NOT NULL, PRIMARY KEY(owner_key,id))''')
    db.execute('''CREATE TABLE IF NOT EXISTS app_savings_goal_meta (
        owner_key TEXT NOT NULL, goal_id TEXT NOT NULL, icon_key TEXT NOT NULL, account_id TEXT NOT NULL,
        PRIMARY KEY(owner_key,goal_id))''')
    db.execute('''CREATE TABLE IF NOT EXISTS app_savings_commands (
        owner_key TEXT NOT NULL, request_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
        result_json TEXT NOT NULL, inverse_json TEXT NOT NULL, PRIMARY KEY(owner_key,request_id))''')


def digest(value: Any) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def account_id(label: str) -> str:
    key = ' '.join(label.casefold().split())
    return 'cash' if key in {'', 'savings', 'cash savings'} else 'account-' + hashlib.sha256(key.encode()).hexdigest()[:20]


def allocations(goals: list[dict[str, Any]], rows: list[dict[str, Any]], frozen: dict[str, Any] | None) -> dict[str, int]:
    """Retain historical allocations; only new/explicitly corrected occurrences use remaining room."""
    by_id = {g['id']: g for g in goals}
    assigned: dict[str, int] = {}
    used: dict[str, int] = defaultdict(int)
    for row in rows:
        old = (frozen or {}).get(row['id'])
        if old and old['amountCents'] == row['amountCents'] and old['goalId'] == row['goalId']:
            assigned[row['id']] = old['allocatedCents']
            used[row['goalId']] += old['allocatedCents']
    for row in sorted(rows, key=lambda r: (r['date'], r['id'])):
        if row['id'] in assigned:
            continue
        goal = by_id.get(row['goalId'])
        if frozen is None and row['date'] <= LEGACY_ALLOCATION_THROUGH:  # Existing allocations are immutable at rollout.
            amount = row['amountCents'] if goal else 0
        else:
            room = max(0, goal['targetCents'] - goal['balanceCents'] - used[goal['id']]) if goal and not goal['archived'] else 0
            amount = min(row['amountCents'], room)
        assigned[row['id']] = amount
        used[row['goalId']] += amount
    return assigned


def _view(store: GoalsStore, owner: str, db: Any, rows: Any) -> dict[str, Any]:
    destinations, source_version = [], ''
    if isinstance(rows, dict):
        destinations, source_version = rows['destinations'], rows['sourceVersion']
        rows = rows['rows']
    raw = db.execute('SELECT * FROM app_savings_goals WHERE owner_key=? ORDER BY archived,created_at DESC,id', (owner,)).fetchall()
    goals = [store._payload(db, g) for g in raw]
    profile = db.execute('SELECT * FROM app_savings_profiles WHERE owner_key=?', (owner,)).fetchone()
    frozen = json.loads(profile['frozen_json']) if profile else None
    shares = allocations(goals, rows, frozen)
    meta = {r['goal_id']: dict(r) for r in db.execute('SELECT * FROM app_savings_goal_meta WHERE owner_key=?', (owner,)).fetchall()}
    saved = {r['id']: dict(r) for r in db.execute('SELECT * FROM app_savings_accounts WHERE owner_key=?', (owner,)).fetchall()}
    cash: dict[str, dict[str, Any]] = {'cash': {'id': 'cash', 'name': 'Savings', 'institutionId': 'other',
        'openingCents': sum(g['balanceCents'] for g in goals) if not profile else 0, 'kind': 'cash'}}
    for label in [*destinations, *(r['toAccount'] for r in rows)]:
        key = account_id(label)
        cash.setdefault(key, {'id': key, 'name': label or 'Savings', 'institutionId': 'other', 'openingCents': 0, 'kind': 'cash'})
    for key, r in saved.items():
        cash[key] = {'id': key, 'name': r['name'], 'institutionId': r['institution_id'], 'openingCents': int(r['opening_cents']), 'kind': 'cash'}
    for a in cash.values():
        a.update(balanceCents=a['openingCents'], allocatedCents=0)
    for r in rows:
        a = cash[account_id(r['toAccount'])]
        a['balanceCents'] += r['amountCents']
        if not next((g['archived'] for g in goals if g['id'] == r['goalId']), True):
            a['allocatedCents'] += shares[r['id']]
    enriched = []
    for g in goals:
        m = meta.get(g['id'], {})
        key = m.get('account_id', 'cash')
        linked = [r for r in rows if r['goalId'] == g['id'] and shares[r['id']] > 0]
        cents = sum(shares[r['id']] for r in linked)
        if not g['archived']:
            cash[key]['allocatedCents'] += g['balanceCents']
        enriched.append({**g, 'accountId': key, 'iconKey': m.get('icon_key', 'target'), 'manualBalanceCents': g['balanceCents'],
            'balanceCents': g['balanceCents'] + cents, 'contributionCents': g['contributionCents'] + cents,
            'contributionCount': g['contributionCount'] + len(linked), 'transferCents': cents, 'transferVersion': digest(linked)})
    for a in cash.values():
        a['availableCents'] = a['balanceCents'] - a['allocatedCents']
        a.pop('openingCents')
    accounts = list(cash.values())
    total = sum(a['balanceCents'] for a in accounts)
    allocated = sum(a['allocatedCents'] for a in accounts)
    version = digest([int(profile['revision']) if profile else 0, goals, meta, saved, rows, destinations, source_version])
    return {'goals': enriched, 'accounts': accounts, 'totals': {'cash': total, 'goals': allocated, 'available': total - allocated},
        'version': version, 'currency': 'USD', 'basis': 'recorded', 'scope': 'personal',
        '_shares': shares, '_rows': rows, '_manual': goals}


def public(value: dict[str, Any]) -> dict[str, Any]:
    return {k: v for k, v in value.items() if not k.startswith('_')}


def listing(store: GoalsStore, owner: str, rows: Any, *, connection: Any = None) -> dict[str, Any]:
    store._owner(owner)
    with nullcontext(connection) if connection is not None else store.access.connect() as db:
        return public(_view(store, owner, db, rows))


def _adopt(db: Any, owner: str, view: dict[str, Any]) -> None:
    db.execute('INSERT INTO app_savings_profiles VALUES (?,0,?) ON CONFLICT(owner_key) DO NOTHING', (owner, '{}'))
    for a in view['accounts']:
        deposits = sum(r['amountCents'] for r in view['_rows'] if account_id(r['toAccount']) == a['id'])
        db.execute('INSERT INTO app_savings_accounts VALUES (?,?,?,?,?) ON CONFLICT(owner_key,id) DO NOTHING', (owner, a['id'], a['name'], a['institutionId'], a['balanceCents'] - deposits))


def _freeze(db: Any, owner: str, view: dict[str, Any]) -> None:
    frozen = {r['id']: {'goalId': r['goalId'], 'amountCents': r['amountCents'], 'allocatedCents': view['_shares'][r['id']]} for r in view['_rows']}
    db.execute('UPDATE app_savings_profiles SET revision=revision+1,frozen_json=? WHERE owner_key=?', (json.dumps(frozen), owner))


def validate_goal_change(view: dict[str, Any], body: dict[str, Any]):
    operation = body.get('operation')
    goal = next((g for g in view['goals'] if g['id'] == body.get('goalId')), None)
    if operation in {'create', 'edit'}:
        icon, key = body.get('iconKey', goal['iconKey'] if goal else 'target'), body.get('accountId', goal['accountId'] if goal else 'cash')
        if icon not in ICONS or not any(a['id'] == key for a in view['accounts']):
            raise GoalValidationError('Choose an icon and account.')
        if goal and key != goal['accountId']:
            raise GoalValidationError('Existing goal allocations stay with their account.')
        starting = _cents(body.get('startingCents', 0), 'Starting allocation', allow_zero=True)
        old = goal['startingCents'] if goal else 0
        if starting - old > next(a['availableCents'] for a in view['accounts'] if a['id'] == key):
            raise GoalValidationError('There is not enough available cash in this account.')
        if not goal and starting > body.get('targetCents', 0):
            raise GoalValidationError('The allocation exceeds the goal target.')
    elif operation == 'contribute' and goal:
        amount = _cents(body.get('amountCents'), 'Allocation')
        if amount > next(a['availableCents'] for a in view['accounts'] if a['id'] == goal['accountId']):
            raise GoalValidationError('There is not enough available cash in this account.')
        if amount > max(0, goal['targetCents'] - goal['balanceCents']):
            raise GoalValidationError('The allocation exceeds the remaining goal amount.')
    elif operation == 'restore' and goal and goal['archived']:
        required = defaultdict(int)
        required[goal['accountId']] += goal['manualBalanceCents']
        for row in view['_rows']:
            if row['goalId'] == goal['id']:
                required[account_id(row['toAccount'])] += view['_shares'][row['id']]
        for account, amount in required.items():
            if amount > next(a['availableCents'] for a in view['accounts'] if a['id'] == account):
                raise GoalValidationError('There is not enough available cash to restore this goal. Release other allocations first.')
    return goal

def _apply(store: GoalsStore, owner: str, db: Any, body: dict[str, Any], view: dict[str, Any]) -> dict[str, Any]:
    operation = body.get('operation')
    if operation == 'account':
        if set(body) - {'operation', 'requestId', 'workspaceVersion', 'accountId', 'name', 'institutionId', 'balanceCents'}:
            raise GoalValidationError('Unexpected account fields.')
        a = next((a for a in view['accounts'] if a['id'] == body.get('accountId')), None)
        if not a:
            raise GoalValidationError('Choose a savings account.')
        name = _text(body.get('name'), 'Account name', 80, required=True)
        institution = body.get('institutionId')
        if institution not in INSTITUTIONS:
            raise GoalValidationError('Choose an institution.')
        balance = _cents(body.get('balanceCents', a['balanceCents']), 'Recorded balance', allow_zero=True)
        if balance < a['allocatedCents']:
            raise GoalValidationError('Release goal allocations before reducing the recorded balance below them.')
        deposits = sum(r['amountCents'] for r in view['_rows'] if account_id(r['toAccount']) == a['id'])
        db.execute('''INSERT INTO app_savings_accounts VALUES (?,?,?,?,?) ON CONFLICT(owner_key,id) DO UPDATE SET
            name=excluded.name,institution_id=excluded.institution_id,opening_cents=excluded.opening_cents''', (owner, a['id'], name, institution, balance - deposits))
        return {'operation': 'account', 'accountId': a['id'], 'name': a['name'], 'institutionId': a['institutionId'], 'balanceCents': a['balanceCents']}
    goal = validate_goal_change(view, body)
    icon = body.get('iconKey', goal['iconKey'] if goal else 'target')
    key = body.get('accountId', goal['accountId'] if goal else 'cash')
    clean = {k: v for k, v in body.items() if k not in {'workspaceVersion', 'iconKey', 'accountId'}}
    before_ids = {r['id'] for r in db.execute('SELECT id FROM app_goal_contributions WHERE owner_key=?', (owner,)).fetchall()}
    result = store.command(owner, clean, connection=db)['goal']
    if operation in {'create', 'edit'}:
        db.execute('''INSERT INTO app_savings_goal_meta VALUES (?,?,?,?) ON CONFLICT(owner_key,goal_id) DO UPDATE SET
            icon_key=excluded.icon_key,account_id=excluded.account_id''', (owner, result['id'], icon, key))
    if operation == 'create':
        return {'operation': 'archive', 'goalId': result['id']}
    if operation == 'edit' and goal:
        return {**{k: goal[k] for k in ('name', 'targetCents', 'startingCents', 'targetDate', 'iconKey', 'accountId')}, 'operation': 'edit', 'goalId': result['id']}
    if operation in {'archive', 'restore'}:
        return {'operation': 'restore' if operation == 'archive' else 'archive', 'goalId': result['id']}
    if operation == 'contribute':
        inserted = next(r['id'] for r in db.execute('SELECT id FROM app_goal_contributions WHERE owner_key=?', (owner,)).fetchall() if r['id'] not in before_ids)
        return {'operation': 'reverse', 'goalId': result['id'], 'contributionId': inserted}
    return {}


def command(store: GoalsStore, owner: str, body: dict[str, Any], source: Any, *, replay_source: Any = None) -> dict[str, Any]:
    store._owner(owner)
    request_id = body.get('requestId')
    if not isinstance(request_id, str) or not re.fullmatch(r'[A-Za-z0-9_-]{16,80}', request_id):
        raise GoalValidationError('A request identifier is required. Reload and try again.')
    allowed = {'create': {'name', 'targetCents', 'startingCents', 'targetDate', 'iconKey', 'accountId'},
        'edit': {'goalId', 'version', 'name', 'targetCents', 'startingCents', 'targetDate', 'iconKey', 'accountId'},
        'contribute': {'goalId', 'version', 'amountCents', 'date', 'note'},
        'archive': {'goalId', 'version'}, 'restore': {'goalId', 'version'},
        'account': {'accountId', 'name', 'institutionId', 'balanceCents'}, 'undo': {'undoId'}}
    operation = body.get('operation')
    if not isinstance(operation, str) or operation not in allowed or set(body) - (allowed[operation] | {'operation', 'requestId', 'workspaceVersion'}):
        raise GoalValidationError('Invalid savings action or fields.')
    signature = digest(body)
    with store.access.connect(write=True) as db:
        db.execute('INSERT INTO app_goal_owners VALUES (?) ON CONFLICT(owner_key) DO NOTHING', (owner,))
        db.execute('SELECT owner_key FROM app_goal_owners WHERE owner_key=?' + store.access._pairing_lock, (owner,)).fetchone()
        db.execute('INSERT INTO app_transaction_owners VALUES (?) ON CONFLICT(owner_key) DO NOTHING', (owner,))
        db.execute('SELECT owner_key FROM app_transaction_owners WHERE owner_key=?' + store.access._pairing_lock, (owner,)).fetchone()
        previous = db.execute('SELECT * FROM app_savings_commands WHERE owner_key=? AND request_id=?', (owner, request_id)).fetchone()
        if previous:
            if previous['fingerprint'] != signature:
                raise GoalConflictError('This request was already used for another change.')
            receipt = json.loads(previous['result_json'])
            latest = public(_view(store, owner, db, (replay_source or source)()))
            # A receipt proves the action happened once, not that its old full
            # snapshot is still current after another device's later command.
            return {**latest, 'undoId': receipt.get('undoId') if latest['version'] == receipt['version'] else None}
        rows = source()  # Under the same owner lock as transfer configuration claims.
        view = _view(store, owner, db, rows)
        if body.get('workspaceVersion') != view['version']:
            raise GoalConflictError('Savings changed on another screen. Refresh and review again.')
        _adopt(db, owner, view)
        _freeze(db, owner, view)
        if body.get('operation') == 'undo':
            if set(body) - {'operation', 'requestId', 'workspaceVersion', 'undoId'}:
                raise GoalValidationError('Unexpected Undo fields.')
            prior = db.execute('SELECT * FROM app_savings_commands WHERE owner_key=? AND request_id=?', (owner, body.get('undoId'))).fetchone()
            if not prior:
                raise GoalValidationError('Choose a saved change to undo.')
            inverse = json.loads(prior['inverse_json'])
            if not inverse:
                raise GoalConflictError('This change cannot be undone again.')
            after_version = json.loads(prior['result_json'])['version']
            if view['version'] != after_version:
                raise GoalConflictError('Savings changed since this action. Refresh before continuing.')
            inverse.update(requestId=request_id)
            if inverse.get('goalId'):
                inverse['version'] = next(g['version'] for g in view['goals'] if g['id'] == inverse['goalId'])
            _apply(store, owner, db, inverse, view)
            undo = {}
        else:
            if body.get('operation') not in {'create', 'edit', 'contribute', 'archive', 'restore', 'account'}:
                raise GoalValidationError('Unknown savings action.')
            undo = _apply(store, owner, db, body, view)
        result = {**public(_view(store, owner, db, rows)), 'undoId': request_id if undo else None}
        db.execute('INSERT INTO app_savings_commands VALUES (?,?,?,?,?)', (owner, request_id, signature, json.dumps(result), json.dumps(undo)))
        return result
