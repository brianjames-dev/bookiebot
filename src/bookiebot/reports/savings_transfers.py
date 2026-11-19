"""Reviewed transfer configuration using existing financial claims/receipts."""
from __future__ import annotations

from dataclasses import replace
from datetime import date, timedelta
import json
import re
from typing import Any

from bookiebot.sheets import savings_transfers as ledger
from bookiebot.sheets.recurring import BillConflict, BillValidation, fingerprint, money_cents, SETTINGS_LOG_TAB
from bookiebot.sheets.recurring_storage import WorkbookSnapshot, SheetBatch, LOG_HEADERS
from bookiebot.sheets.routing import get_user_config, now_pacific

OPERATIONS = {'transfer-create', 'transfer-update', 'transfer-stop'}


def _goals(owner: str) -> list[dict[str, Any]]:
    from bookiebot.reports.goals_store import build_goals_store
    return build_goals_store().list_goals(owner)['goals']


def settings_version(owner: str, year: int, rules: list[ledger.Transfer]) -> str:
    return fingerprint([owner, year, ledger.version(rules)])


def next_date(rules: list[ledger.Transfer], identity: str, today: date) -> str | None:
    selected = [r for r in rules if r.id == identity]
    last_start = max((date.fromisoformat(r.starts_on) for r in selected), default=today)
    end = min(date(2200, 12, 31), max(today, last_start) + timedelta(days=370))
    return next((r['date'] for r in ledger.occurrences(selected, today, end)), None)


def listing(actor: str) -> dict[str, Any]:
    today = now_pacific().date()
    owner = get_user_config(actor).budget_owner_key
    source = ledger.read_source(actor)
    rules = ledger.decode(source.rows.get(ledger.TRANSFER_TAB, []))
    goals = _goals(owner)
    names = {g['id']: g['name'] for g in goals}
    return {'today': today.isoformat(), 'year': source.year, 'ownerName': owner.title(),
            'settingsVersion': settings_version(owner, source.year, rules), 'goals': goals,
            'transfers': [{**t.public(), 'goalName': names.get(t.goal_id, ''),
                           'nextDate': next_date(rules, t.id, today + timedelta(days=1))} for t in ledger.current(rules)]}


def review(actor: str, body: dict[str, Any], source: WorkbookSnapshot) -> dict[str, Any]:
    today = now_pacific().date()
    allowed = {'operation', 'settingsVersion', 'year', 'draftId', 'id', 'revision', 'transfer', 'requestId', 'reviewVersion'}
    operation = body.get('operation')
    if set(body) - allowed or operation not in OPERATIONS or type(body.get('year')) is not int or body['year'] != source.year:
        raise BillValidation('Refresh Transfers and start a new review.')
    rules = ledger.decode(source.rows.get(ledger.TRANSFER_TAB, []))
    if body.get('settingsVersion') != settings_version(source.owner, source.year, rules):
        raise BillConflict('Transfers changed. Refresh and review again.')
    before = next((t for t in ledger.current(rules) if t.id == body.get('id')), None)
    if operation == 'transfer-create':
        if len(ledger.current(rules)) >= 200:
            raise BillValidation('This account already has 200 transfers.')
        if body.get('id') is not None or body.get('revision') is not None or not isinstance(body.get('draftId'), str) or not re.fullmatch(r'[A-Za-z0-9_-]{8,80}', body['draftId']):
            raise BillValidation('Start a new transfer draft.')
        identity = 'saving_' + fingerprint([source.owner, body['draftId']])[:24]
        if any(r.id == identity for r in rules):
            raise BillConflict('This transfer draft is already saved. Refresh Transfers.')
        effective = max(today, ledger.TRANSFER_EPOCH)
    else:
        if before is None or type(body.get('revision')) is not int or body['revision'] != before.revision:
            raise BillConflict('This transfer changed. Select it again before editing.')
        identity, effective = before.id, today + timedelta(days=1)
    if operation == 'transfer-stop':
        if before is None or not before.active or 'transfer' in body:
            raise BillValidation('Choose an active transfer to stop.')
        after = replace(before, revision=before.revision + 1, active=False, effective_from=effective.isoformat())
    else:
        fields = body.get('transfer')
        if not isinstance(fields, dict) or set(fields) != {'name', 'amount', 'frequency', 'startsOn', 'goalId', 'fromAccount', 'toAccount'}:
            raise BillValidation('Complete the transfer details.')
        def text(key: str, *, required: bool = False) -> str:
            value = fields[key]
            if not isinstance(value, str) or len(value.strip()) > 80 or any(ord(c) < 32 for c in value) or required and not value.strip():
                raise BillValidation('Use a short name and account labels for this transfer.')
            return value.strip()
        name, goal_id = text('name', required=True), text('goalId')
        start = ledger.iso_date(fields['startsOn'])
        amount = money_cents(fields['amount'])
        if amount is None or not 1 <= amount <= 10_000_000_000 or fields['frequency'] not in ledger.FREQUENCIES or start < effective.isoformat():
            raise BillValidation('Choose a positive amount and an eligible transfer date.')
        goals = _goals(source.owner)
        goal = next((g for g in goals if g['id'] == goal_id and not g['archived']), None)
        if goal_id and goal is None:
            raise BillConflict('Choose one of your active savings goals, or No goal.')
        # Editing an amount/link must not change a January-31 anchor into
        # February-28 merely because the next displayed date is clamped.
        anchor = before.starts_on if before and before.active and before.frequency == fields['frequency'] and next_date(rules, before.id, effective) == start else start
        after = ledger.Transfer(identity, before.revision + 1 if before else 1, name, amount, fields['frequency'], anchor,
                                effective.isoformat(), goal_id, text('fromAccount'), text('toAccount'),
                                adjustments=before.adjustments if before else ())
    updated = [r for r in rules if r.id != identity or r.effective_from < effective.isoformat()] + [after]
    names = {g['id']: g for g in _goals(source.owner)}
    after_public = {**after.public(), 'goalName': names.get(after.goal_id, {}).get('name', ''),
                    'nextDate': next_date(updated, identity, effective)}
    checked = {'operation': operation, 'effectiveFrom': effective.isoformat(),
               'before': {**before.public(), 'goalName': names.get(before.goal_id, {}).get('name', ''),
                          'nextDate': next_date(rules, before.id, effective)} if before else None, 'after': after_public}
    checked['reviewVersion'] = fingerprint([source.owner, body.get('settingsVersion'), checked,
                                           names.get(after.goal_id, {}).get('version'), today.isoformat()])
    return {'review': checked, 'rules': updated}


def configuration_batch(source: WorkbookSnapshot, checked: dict[str, Any], request_id: str, digest: str,
                        *, result: dict[str, Any] | None = None, audit: dict[str, Any] | None = None):
    batch = SheetBatch(source)
    # Transfer records are literal JSON, including user-entered names. They
    # never run through editable-formula preservation or a bank/payment writer.
    rows = ledger.encode(checked['rules'])
    batch.values(ledger.TRANSFER_TAB, 1, 1, rows, hidden=True)
    old_count = len(source.rows.get(ledger.TRANSFER_TAB, []))
    if old_count > len(rows):
        batch.values(ledger.TRANSFER_TAB, len(rows) + 1, 1, [[''] * len(ledger.HEADERS) for _ in range(old_count - len(rows))], hidden=True)
    result = result or {'state': 'done', 'success': True, 'detail': 'Transfer stopped.' if checked['review']['operation'] == 'transfer-stop' else 'Transfer saved.'}
    receipt = {**result, **({'_transferUndo': audit} if audit else {})}
    batch.values(SETTINGS_LOG_TAB, 1, 1, [LOG_HEADERS], hidden=True)
    batch.values(SETTINGS_LOG_TAB, max(2, len(source.rows.get(SETTINGS_LOG_TAB, [])) + 1), 1,
                 [[request_id, digest, json.dumps(receipt), now_pacific().isoformat()]], hidden=True)
    return batch, result


def goal_payload(actor: str, result: dict[str, Any], *, today: date | None = None, store: Any = None, owner: str = "") -> dict[str, Any]:
    today = today or now_pacific().date()
    rows = ledger.occurrences(ledger.read_all(actor, today=today), date(2000, 1, 1), today)
    if store is not None:
        from bookiebot.reports import savings_workspace as workspace
        owner = owner or get_user_config(actor).budget_owner_key
        mapped = {g['id']: g for g in workspace.listing(store, owner, rows)['goals']}
        return {**result, 'goals': [mapped.get(g['id'], g) for g in result['goals']]}
    goals = []
    for goal in result['goals']:
        linked = [r for r in rows if r['goalId'] == goal['id']]
        cents = sum(r['amountCents'] for r in linked)
        goals.append({**goal, 'balanceCents': goal['balanceCents'] + cents,
                      'contributionCents': goal['contributionCents'] + cents,
                      'contributionCount': goal['contributionCount'] + len(linked), 'transferCents': cents,
                      'transferVersion': fingerprint(linked)})
    return {**result, 'goals': goals}


def goal_history(actor: str, owner: str, identity: str, offset: int, *, store: Any = None) -> dict[str, Any]:
    from bookiebot.reports.goals_store import build_goals_store
    if not 0 <= offset <= 100_000:
        raise BillValidation('Choose a valid contribution history page.')
    store = store or build_goals_store()
    # Read each bounded SQL page; merge before pagination so transfers cannot
    # create duplicate/missing entries at manual/automatic page boundaries.
    manual: list[dict[str, Any]] = []
    page = 0
    more_manual = False
    while page <= offset + 25:
        loaded = store.history(owner, identity, offset=page)
        manual.extend(loaded['contributions'])
        if loaded['nextOffset'] is None:
            break
        page = loaded['nextOffset']
        more_manual = page > offset + 25
    today = now_pacific().date()
    rows = ledger.occurrences(ledger.read_all(actor, today=today), date(2000, 1, 1), today)
    from bookiebot.reports import savings_workspace as workspace
    if hasattr(store, 'access'):
        with store.access.connect() as db:
            shares = workspace._view(store, owner, db, rows)['_shares']
    else:
        shares = {r['id']: r['amountCents'] for r in rows}
    automatic = [{**r, 'amountCents': shares[r['id']], 'createdAt': r['date'] + 'T00:00:00',
                  'note': r['name'] + ' · Scheduled transfer', 'reversedAt': ''}
                 for r in rows if r['goalId'] == identity and shares[r['id']] > 0]
    combined = sorted([*manual, *automatic], key=lambda r: (r['createdAt'], r['id']), reverse=True)
    return {'contributions': combined[offset:offset + 25], 'nextOffset': offset + 25 if more_manual or len(combined) > offset + 25 else None}


def can_archive_goal(actor: str, owner: str, identity: str, *, commands: Any) -> None:
    from bookiebot.reports.goals_store import GoalConflictError
    if commands.blocked(owner):
        raise GoalConflictError('Finish checking your financial change before archiving this goal.')
    today = now_pacific().date()
    rules = ledger.read_all(actor, today=today)
    if any(t.goal_id == identity and t.active and next_date(rules, t.id, today + timedelta(days=1))
           for t in ledger.current(rules)):
        raise GoalConflictError('Unlink or stop this goal’s future transfers before archiving it.')
