"""Canonical fixtures for the approved UI, with no Sheets or live data access."""
import json
import os
from datetime import timedelta
from pathlib import Path
from uuid import uuid4

from bookiebot.reports.app_access import AppAccessStore
from bookiebot.reimbursements.store import ReimbursementStore
from bookiebot.sheets.routing import now_pacific


def test_refinement_operation_reversals_and_reset_reinstatement(tmp_path, monkeypatch):
    from bookiebot.reimbursements import service
    access = AppAccessStore(tmp_path / 'refinements.sqlite3')
    access.initialize()
    store = ReimbursementStore(access)
    store.initialize()
    monkeypatch.setattr(service, 'build_reimbursement_store', lambda: store)
    today = now_pacific().date()
    current = today.replace(day=1)
    steps = []

    def add(identifier, amount, payer='brian', when=current):
        row = store.register_allocation({
            'id': identifier, 'payerOwner': payer, 'partnerOwner': 'hannah' if payer == 'brian' else 'brian',
            'payerPerson': payer.title(), 'item': identifier.title(), 'location': '', 'expenseDate': when.isoformat(),
            'category': 'Shopping', 'sourceWorksheet': 'expense', 'sourceRow': 10,
            'sourceActionId': 'source-'+identifier, 'splitActionId': 'split-'+identifier,
            'sourceYear': when.year, 'sourceSpreadsheetId': '', 'grossCents': amount*2,
            'payerShareCents': amount, 'partnerShareCents': amount, 'settledCents': 0,
            'method': 'equal', 'accounting': 'cash_v1',
        })
        store.mark_projected(row['id'], row['version'])

    def snap():
        return service.snapshot('brian', retry_projection=False)

    def apply(body, owner='brian', record=True):
        result = store.command(owner, {**body, 'requestId': uuid4().hex})
        for row in result['allocations']:
            store.mark_projected(row['id'], row['version'])
        value = {**result, **snap()}
        if record:
            steps.append({'command': body, 'result': value})
        return value

    for index, amount in enumerate((16200, 27650, 4800, 25150)):
        add('archive-'+str(index), amount, when=current-timedelta(days=120-index))
        apply({'operation': 'reset', 'expectedState': snap()['resetState'], 'note': 'Isolated archived fixture'}, owner='hannah' if index % 2 else 'brian', record=False)
    for identifier, amount, owner, when in [('rent', 50000, 'brian', current-timedelta(days=1)),
                                           ('pge', 5364, 'brian', current), ('water', 2255, 'brian', current),
                                           ('foods', 2313, 'brian', current), ('target', 2395, 'hannah', current),
                                           ('costco', 6130, 'hannah', current)]:
        add(identifier, amount, owner, when)
    initial = snap()
    original = {row['id']: row for row in initial['allocations']}

    def offset():
        rows = {row['id']: row for row in snap()['allocations']}
        return apply({'operation': 'offset', 'date': today.isoformat(), 'note': '', 'entries': [
            {'allocationId': key, 'version': rows[key]['version'], 'amountCents': amount}
            for key, amount in [('rent', 8525), ('costco', 6130), ('target', 2395)]]})

    first = offset()
    apply({'operation': 'reverse_operation', 'operationId': first['operationId'], 'expectedState': snap()['resetState']})
    offset()
    receipt = apply({'operation': 'receive_all', 'expectedState': snap()['resetState'], 'date': today.isoformat(), 'note': ''})
    cash_undone = apply({'operation': 'reverse_operation', 'operationId': receipt['operationId'], 'expectedState': snap()['resetState']})
    assert sum(row['outstandingCents'] for row in cash_undone['allocations']) == 51407
    assert all(event['status'] == 'confirmed' for event in cash_undone['events'] if event['kind'] == 'offset' and event['operationId'] != first['operationId'])
    reset = apply({'operation': 'reset', 'expectedState': snap()['resetState'], 'note': ''})
    reset_id = reset['reset']['id']
    undo = apply({'operation': 'undo_reset', 'resetId': reset_id, 'version': 1})
    assert sum(row['outstandingCents'] for row in undo['allocations']) == 51407
    redo = apply({'operation': 'redo_reset', 'resetId': reset_id, 'version': 2})
    assert all(row['outstandingCents'] == 0 for row in redo['allocations'])
    apply({'operation': 'undo_reset', 'resetId': reset_id, 'version': 3})
    for row in snap()['allocations']:
        for key in ('grossCents', 'payerShareCents', 'partnerShareCents', 'expenseDate', 'sourceActionId'):
            assert row[key] == original[row['id']][key]
    assert store.snapshot('brian')['allocations'] == store.snapshot('hannah')['allocations']
    if output := os.getenv('BOOKIEBOT_REFINEMENT_FIXTURE'):
        Path(output).write_text(json.dumps({'initial': initial, 'steps': steps}))
