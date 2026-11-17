"""Export real isolated durable phases for two-phone native browser verification."""
import json
import os
from pathlib import Path
from uuid import uuid4

from bookiebot.reimbursements import service
from bookiebot.reimbursements.store import ReimbursementStore
from bookiebot.reimbursements.presentation import display_snapshot
from bookiebot.reports.app_access import AppAccessStore
from bookiebot.sheets.routing import now_pacific
from unit_tests.reimbursements.test_store import payload, command


def test_queued_undo_browser_phases_preserve_original_purchases(tmp_path, monkeypatch):
    cases = {}
    for kind in ("payment", "offset", "reset"):
        access = AppAccessStore(tmp_path / (kind + '.sqlite3'))
        access.initialize()
        store = ReimbursementStore(access)
        store.initialize()
        monkeypatch.setattr(service, 'build_reimbursement_store', lambda: store)
        today = now_pacific().date().isoformat()
        first = store.register_allocation(payload(id='rent', item='Rent', expenseDate=today, grossCents=10000, payerShareCents=6000, partnerShareCents=4000))
        if kind == 'offset':
            store.register_allocation(payload(id='water', item='Water', expenseDate=today, payerOwner='hannah', partnerOwner='brian', payerPerson='Hannah'))
        def project():
            for row in store.pending_projections():
                store.mark_projected(row['id'], row['version'])
        def snap():
            return {owner: service.snapshot(owner) for owner in ('brian', 'hannah')}
        project()
        initial = snap()
        if kind == 'payment':
            body = {'operation': 'receive_all', 'expectedState': initial['brian']['resetState'], 'date': today, 'note': ''}
        elif kind == 'offset':
            body = {'operation': 'offset', 'date': today, 'note': '', 'entries': [
                {'allocationId': row['id'], 'version': row['version'], 'amountCents': 4000}
                for row in initial['brian']['allocations']]}
        else:
            body = {'operation': 'reset', 'expectedState': initial['brian']['resetState'], 'note': ''}
        result = store.command('brian', {**body, 'requestId': uuid4().hex})
        saved = snap()
        saved['brian'].update({key: result[key] for key in ('operationId', 'reset') if key in result})
        target = {'action': 'undo_reset', 'resetId': result['reset']['id'], 'version': result['reset']['version']} if kind == 'reset' else {'action': 'reverse_operation', 'operationId': result['operationId']}
        undo = {'operation': 'queue_undo', 'expectedUndoState': saved['brian']['undoState'], **target}
        job = store.command('brian', {**undo, 'requestId': uuid4().hex})['undoJob']
        queued = snap()
        queued['brian']['undoJob'] = job
        assert [row['settledCents'] for row in queued['brian']['allocations']] == [row['settledCents'] for row in saved['brian']['allocations']]
        assert [row['clearedCents'] for row in queued['brian']['allocations']] == [row['clearedCents'] for row in saved['brian']['allocations']]
        project()
        store.command('brian', {'operation': 'queued_undo', 'requestId': 'queued-undo-'+job['id']}, _undo_job_id=job['id'])
        project()
        completed = snap()
        for owner in ('brian', 'hannah'):
            assert completed[owner]['undoJobs'][0]['status'] == 'completed'
            displayed = display_snapshot(queued[owner])
            assert displayed['displayPending']
            for key in ('settledCents', 'clearedCents', 'outstandingCents', 'status'):
                assert [r[key] for r in displayed['allocations']] == [r[key] for r in completed[owner]['allocations']]
            assert all(r['version'] == old['version'] for r, old in zip(displayed['allocations'], queued[owner]['allocations']))
            assert completed[owner]['allocations'][0]['grossCents'] == first['grossCents']
            assert [r['outstandingCents'] for r in completed[owner]['allocations']] == [r['outstandingCents'] for r in initial[owner]['allocations']]
        cases[kind] = {'initial': initial, 'saved': saved, 'queued': queued, 'completed': completed, 'command': body, 'undo': undo}
    if output := os.getenv('BOOKIEBOT_QUEUED_UNDO_FIXTURE'):
        Path(output).write_text(json.dumps(cases))


def test_shared_display_resource_matches_canonical_inverse(tmp_path, monkeypatch):
    import subprocess
    root = Path(__file__).resolve().parents[2]
    fixture = tmp_path / 'phases.json'
    monkeypatch.setenv('BOOKIEBOT_QUEUED_UNDO_FIXTURE', str(fixture))
    test_queued_undo_browser_phases_preserve_original_purchases(tmp_path, monkeypatch)
    subprocess.run(['node', 'unit_tests/reports/reimbursement_display_state_test.cjs'], cwd=root, check=True, capture_output=True, text=True)
