"""Actual phone → bank lock → canonical ledger → synthetic Sheets integration."""
import pytest

from bookiebot.banking import service as banking
from bookiebot.reimbursements import service as repayments, projection
from bookiebot.reports import phone_reconciliation as review
from bookiebot.reports.phone_reconciliation import _invalidate_review_actions as invalidate_review_actions
from bookiebot.sheets import undo
from bookiebot.sheets.routing import now_pacific
from unit_tests.reimbursements.test_store import access, payment  # noqa: F401
from unit_tests.reimbursements.test_service import setup, FIELDS, VALUES, BRIAN  # noqa: F401
from unit_tests.reports.test_phone_reconciliation import client, seed, connect, details, HEADERS  # noqa: F401


def prepare(setup, client, monkeypatch):
    monkeypatch.setattr(review, '_invalidate_review_actions', invalidate_review_actions)
    today = now_pacific().date()
    values = {**VALUES, "date": today.strftime('%m/%d/%Y'), "amount": "221.82", "item": "Sushi dinner"}
    setup.sheet.write(2, 29, list(values.values()))
    assert repayments.record_split(BRIAN, setup.logged, setup.sheet, FIELDS, values,
        "Brian (BofA)", "equal", 221.82, 110.91, 110.91, expense_date=today)[0]
    value = setup.store.snapshot('brian')['allocations'][0]
    repayments.command('brian', payment(value, 6188))
    original = undo.LoggedAction(setup.logged.id, today.isoformat() + 'T12:00:00', BRIAN, setup.logged.action)
    def source(_actor):
        value = setup.store.get_allocation(value_id)
        return [undo._allocation_action(original, value, for_reconciliation=True)]
    value_id = value['id']
    monkeypatch.setattr(review, 'read_active_logged_actions', source)
    monkeypatch.setattr(banking, '_read_current_logged_actions', source)
    item = seed(client, amount=226.94)
    connect(client)
    return item, value_id


@pytest.mark.asyncio
@pytest.mark.parametrize('projection_failure', [False, True])
async def test_shared_correction_full_bank_match_and_resume_preserve_received(setup, client, monkeypatch, projection_failure):
    item, allocation_id = prepare(setup, client, monkeypatch)
    before = setup.store.snapshot('brian')
    row = await details(client, item.id)
    suggestion = next(s for s in row['suggestions'] if s['id'] == setup.logged.id)
    plan = suggestion['sharedAmount']
    assert (plan['previousGrossCents'], plan['grossCents'], plan['payerShareCents'], plan['partnerShareCents'],
            plan['receivedCents'], plan['remainingCents']) == (22182, 22694, 11347, 11347, 6188, 5159)
    body = dict(operation='update_match', id=item.id, version=row['version'], suggestionId=setup.logged.id)
    # Old/crafted clients cannot bypass the explicit revised repayment review.
    rejected = await client.http.post('/app/reconciliation', headers=HEADERS, json=body)
    assert rejected.status == 409 and (await rejected.json())['outcome'] == 'not_applied'
    assert setup.store.snapshot('brian') == before
    body['sharedAmountToken'] = plan['token']
    real_sync = projection.sync_pending
    if projection_failure:
        monkeypatch.setattr(projection, 'sync_pending', lambda *a, **kw: False)
    response = await client.http.post('/app/reconciliation', headers=HEADERS, json=body)
    if projection_failure:
        assert response.status == 409 and 'outcome' not in await response.json()
        assert client.service.get_reconciliation_item('brian', item.id).status == 'needs_review'
        current = await details(client, item.id)
        saved_plan = next(s for s in current['suggestions'] if s['id'] == setup.logged.id)['sharedAmount']
        assert saved_plan['recovery'] and saved_plan['token'] == plan['token']
        monkeypatch.setattr(projection, 'sync_pending', real_sync)
        body['version'] = current['version']
        response = await client.http.post('/app/reconciliation', headers=HEADERS, json=body)
    assert response.status == 200, await response.text()
    result = setup.store.get_allocation(allocation_id)
    assert result['version'] == result['projectedVersion'] == before['allocations'][0]['version'] + 1
    assert result['grossCents'] == 22694 and result['settledCents'] == 6188 and result['outstandingCents'] == 5159
    assert setup.sheet.read(2, 31, 32) == [165.06]
    assert setup.store.snapshot('brian')['events'] == before['events']
    matched = client.service.get_reconciliation_item('brian', item.id)
    assert matched.status == 'confirmed' and matched.matched_action_log_id == setup.logged.id
    # A repeated old POST cannot replay its writer.
    response = await client.http.post('/app/reconciliation', headers=HEADERS, json=body)
    assert response.status == 409
    assert setup.store.get_allocation(allocation_id)['version'] == result['version']
