"""Reviewed corrections to one dated transfer, independent of its recurrence."""
from __future__ import annotations

from dataclasses import asdict, replace
from datetime import date
import json
import re
from typing import Any

from bookiebot.reports import savings_transfers as schedules
from bookiebot.reports.transactions import TransactionConflict, TransactionValidation, _transfer_row, digest
from bookiebot.sheets import savings_transfers as ledger
from bookiebot.sheets.recurring import SETTINGS_LOG_TAB
from bookiebot.sheets.routing import get_user_config, now_pacific

ENTRY = re.compile(r'(?P<month>\d{4}-\d{2}):transfer-(?P<identity>[A-Za-z0-9_-]{8,80})-(?P<day>\d{4}-\d{2}-\d{2})')
UNDO = re.compile(r'(?P<month>\d{4}-\d{2}):transfer-change-(?P<request>[A-Za-z0-9_-]{16,80})')
EDITABLE = {'amount', 'item', 'fromAccount', 'toAccount', 'goalId'}


def handles(body: dict[str, Any]) -> bool:
    return isinstance(body.get('id'), str) and bool(re.match(r'^\d{4}-\d{2}:transfer-', body['id']))


def receipt(source: Any, request_id: str, fingerprint: str | None = None) -> dict[str, Any] | None:
    found = [row for row in source.rows.get(SETTINGS_LOG_TAB, [])[1:] if row and row[0] == request_id]
    if not found:
        return None
    if len(found) != 1 or len(found[0]) < 3 or fingerprint is not None and found[0][1] != fingerprint:
        raise TransactionConflict('The original transfer receipt needs verification.')
    result = json.loads(found[0][2])
    if not isinstance(result, dict) or not result.get('success') or result.get('state') != 'done':
        raise TransactionConflict('The original transfer receipt needs verification.')
    return result


def public_result(value: dict[str, Any]) -> dict[str, Any]:
    return {k: v for k, v in value.items() if not k.startswith('_')}


def _item(plans: list[ledger.Transfer], identity: str, when: date) -> tuple[dict[str, Any], ledger.Transfer, ledger.OccurrenceAdjustment | None]:
    group = [p for p in plans if p.id == identity]
    if not group or when < ledger.TRANSFER_EPOCH or when > now_pacific().date():
        raise TransactionConflict('Choose an existing, due transfer before editing it.')
    latest = max(group, key=lambda p: p.revision)
    base = ledger.occurrences([replace(p, adjustments=()) for p in group], when, when)
    if len(base) != 1:
        raise TransactionConflict('The original transfer date is no longer verifiable.')
    item = base[0]
    adjustment = next((a for a in latest.adjustments if a.scheduled_on == when.isoformat()), None)
    if adjustment:
        item = {**item, 'name': adjustment.name, 'amountCents': adjustment.amount_cents,
                'goalId': adjustment.goal_id, 'fromAccount': adjustment.from_account,
                'toAccount': adjustment.to_account, 'adjustmentRevision': adjustment.revision,
                **({'deleted': True} if adjustment.deleted else {})}
    return item, latest, adjustment


def review(actor: str, body: dict[str, Any]) -> dict[str, Any]:
    allowed = {'id', 'month', 'version', 'operation', 'updates', 'requestId', 'reviewVersion'}
    operation = body.get('operation')
    if set(body) - allowed or operation not in {'update', 'delete', 'undo'}:
        raise TransactionValidation('Choose Edit or Delete for this individual transfer.')
    if operation == 'undo' and 'updates' in body:
        raise TransactionValidation('Undo restores the original individual transfer change.')
    source = ledger.read_source(actor)
    plans = ledger.decode(source.rows.get(ledger.TRANSFER_TAB, []))
    prior_audit = None
    if operation == 'undo':
        match = UNDO.fullmatch(str(body.get('id', '')))
        if not match or body.get('month') != match['month']:
            raise TransactionValidation('Choose a saved transfer change to undo.')
        saved = receipt(source, match['request'])
        prior_audit = saved.get('_transferUndo') if saved else None
        if not isinstance(prior_audit, dict) or prior_audit.get('version') != 1 or prior_audit.get('operation') not in {'update', 'delete'}:
            raise TransactionConflict('This transfer change has no verifiable Undo history.')
        identity, day = prior_audit['transferId'], prior_audit['date']
        if day[:7] != body['month']:
            raise TransactionConflict('The original transfer month changed.')
    else:
        match = ENTRY.fullmatch(str(body.get('id', '')))
        if not match or body.get('month') != match['month'] or match['day'][:7] != match['month']:
            raise TransactionValidation('Choose the transfer’s original recorded month.')
        identity, day = match['identity'], match['day']
    when = date.fromisoformat(ledger.iso_date(day))
    before, latest, previous = _item(plans, identity, when)
    if prior_audit:
        if previous is None or asdict(previous) != prior_audit.get('expectedAdjustment'):
            raise TransactionConflict('This transfer changed after that edit. It cannot be undone over a newer change.')
    elif before.get('deleted'):
        raise TransactionConflict('This individual transfer has already been deleted.')
    goals = schedules._goals(source.owner)
    names = {g['id']: g['name'] for g in goals}
    row = _transfer_row(actor, day[:7], before, goal_names=names, goals=goals)
    if body.get('version') != row['version'] and not (operation == 'undo' and body.get('version') is None):
        raise TransactionConflict('This transfer changed. Refresh Transactions and review it again.')
    if operation == 'undo':
        assert prior_audit is not None
        after = dict(prior_audit['before'])
        normalized = {'operation': operation}
        row['capabilities'] = {key: key == 'undo' for key in row['capabilities']}
    else:
        updates = body.get('updates', {})
        if not isinstance(updates, dict) or set(updates) - EDITABLE or operation != 'update' and updates:
            raise TransactionValidation('Choose an editable field for this individual transfer.')
        clean = {}
        for key, value in updates.items():
            if key == 'amount':
                if type(value) is not int or not 1 <= value <= 10_000_000_000:
                    raise TransactionValidation('Enter a positive transfer amount in whole cents.')
                clean[key] = f'{value / 100:.2f}'
            elif (not isinstance(value, str) or len(value.strip()) > 80 or any(ord(c) < 32 for c in value)
                  or key == 'item' and not value.strip()):
                raise TransactionValidation('Use a short name and account labels for this transfer.')
            else:
                clean[key] = value.strip()
        clean = {k: v for k, v in clean.items() if v != row['fields'].get(k, '')}
        if operation == 'update' and not clean:
            raise TransactionValidation('Change this transfer’s amount, name, accounts or savings goal.')
        fields = {**row['fields'], **clean}
        after = {**before, 'name': fields['item'], 'amountCents': round(float(fields['amount']) * 100),
                 'goalId': fields['goalId'], 'fromAccount': fields['fromAccount'], 'toAccount': fields['toAccount']}
        if operation == 'delete':
            after['deleted'] = True
        normalized = {'operation': operation, **({'updates': clean} if clean else {})}
    target_goal = next((g for g in goals if g['id'] == after['goalId']), None)
    if after['goalId'] and (target_goal is None or target_goal.get('archived') and operation != 'undo' and after['goalId'] != before['goalId']):
        raise TransactionConflict('Choose one of your active personal goals, or No goal.')
    adjustment = ledger.OccurrenceAdjustment(day, (previous.revision if previous else 0) + 1, after['name'],
        after['amountCents'], after['goalId'], after['fromAccount'], after['toAccount'], bool(after.get('deleted')))
    updated = [replace(p, adjustments=tuple(a for a in p.adjustments if a.scheduled_on != day) + (adjustment,))
               if p.id == latest.id and p.revision == latest.revision else p for p in plans]
    after_fields = _transfer_row(actor, day[:7], after, goal_names=names, goals=goals)['fields']
    effect = {'savedBeforeCents': 0 if before.get('deleted') else before['amountCents'],
              'savedAfterCents': 0 if after.get('deleted') else after['amountCents'],
              'goalBeforeId': before['goalId'], 'goalAfterId': after['goalId'],
              'goalBeforeName': names.get(before['goalId'], ''), 'goalAfterName': names.get(after['goalId'], '')}
    payload = {'item': row, 'operation': operation, 'after': after_fields, 'destination': None,
               'transferEffect': effect, 'reviewVersion': digest([row['version'], normalized, after_fields, effect, bool(after.get('deleted'))])}
    if operation == 'undo' and prior_audit is not None and prior_audit['operation'] == 'update':
        payload['restoration'] = {'operation': 'update', 'current': row['fields'],
                                  'currentCategory': row['categoryLabel'], 'restoredCategory': row['categoryLabel']}
    audit = {'version': 1, 'operation': operation, 'transferId': identity, 'date': day,
             'before': before, 'after': after, 'expectedAdjustment': asdict(adjustment)}
    return {'review': payload, '_row': row, '_normalized': normalized,
            '_transfer': {'source': source, 'rules': updated, 'audit': audit}}


def batch(checked: dict[str, Any], request_id: str, fingerprint: str):
    value, row, reviewed = checked['_transfer'], checked['_row'], checked['review']
    operation = reviewed['operation']
    result = {'state': 'done', 'success': True,
        'detail': 'Individual transfer deleted.' if operation == 'delete' else 'Transfer change undone.' if operation == 'undo' else 'Individual transfer updated.',
        'summary': {'operation': operation, 'kind': 'transfer', 'title': row['title'], 'date': row['date'],
                    'category': row['categoryLabel'], 'location': row['location'], 'person': row['person'],
                    'amountCents': row['amountCents'], 'before': dict(row['fields']), 'after': dict(reviewed['after']),
                    **{k: reviewed[k] for k in ('restoration', 'transferEffect') if k in reviewed}}}
    if operation != 'undo':
        result['undo'] = {'id': row['month'] + ':transfer-change-' + request_id, 'month': row['month']}
    return schedules.configuration_batch(value['source'], {'rules': value['rules'], 'review': reviewed},
        request_id, fingerprint, result=result, audit=value['audit'])
