from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest

from bookiebot.reports import bill_checkin as checkin
from bookiebot.sheets.recurring import BillValidation, BILL_TAB
from bookiebot.sheets.recurring_rows import encode
from bookiebot.sheets import recurring_storage as storage
from bookiebot.sheets.routing import PACIFIC_TZ
from unit_tests.reports.test_goals_store import access as access
from unit_tests.sheets.test_recurring_storage import fixture, B
from unit_tests.sheets.test_recurring import plan

NOW = datetime(2026, 11, 15, 12, tzinfo=PACIFIC_TZ)


@pytest.fixture
def store(access):
    access.initialize()
    return checkin.BillCheckinStore(access)


def test_claim_ack_and_later_are_once_per_person_pacific_day(store):
    token, other = 'first-device-token', 'second-device-token'
    assert store.day('brian', token, 'claim', NOW)['claimed']
    denied = store.day('brian', other, 'claim', NOW)
    assert not denied['claimed'] and denied['reason'] == 'reserved' and denied['retryAfterSeconds'] == checkin.LEASE_SECONDS
    assert not store.day('hannah', token, 'shown', NOW)['shown']
    assert store.day('brian', token, 'shown', NOW)['shown']
    assert store.day('brian', token, 'shown', NOW)['shown']  # Lost ack is idempotent.
    denied = store.day('brian', other, 'claim', NOW + timedelta(hours=11))
    assert not denied['claimed'] and denied['reason'] == 'shown'
    assert not store.day('brian', other, 'claim', datetime(2026, 11, 16, 7, tzinfo=timezone.utc))['claimed']
    assert store.day('hannah', other, 'claim', NOW)['claimed']
    assert store.day('brian', other, 'claim', NOW + timedelta(days=1))['claimed']


def test_unshown_deferred_or_abandoned_attempt_does_not_use_the_day(store):
    assert store.day('brian', 'first-device-token', 'claim', NOW)['claimed']
    store.day('brian', 'wrong-device-token', 'release', NOW)
    assert not store.day('brian', 'second-device-token', 'claim', NOW)['claimed']
    store.day('brian', 'first-device-token', 'release', NOW)
    assert store.day('brian', 'second-device-token', 'claim', NOW)['claimed']
    later = NOW + timedelta(seconds=checkin.LEASE_SECONDS + 1)
    assert not store.day('brian', 'second-device-token', 'shown', later)['shown']
    assert store.day('brian', 'third-device-token', 'claim', later)['claimed']


def test_two_devices_cannot_claim_the_same_person_day(store):
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda token: store.day('brian', token, 'claim', NOW), ['first-device-token', 'second-device-token']))
    assert sum(r['claimed'] for r in results) == 1


def test_preferences_are_per_owner_and_validate_without_any_bill_ledger(store):
    store.preference('brian', 'pge', 14)
    store.preference('hannah', 'pge', None)
    assert store.preferences('brian') == {'pge': 14}
    assert store.preferences('hannah') == {'pge': None}
    for value in (True, 0, -1, 31, '7', 2.5):
        with pytest.raises(BillValidation):
            store.preference('brian', 'pge', value)
    assert store.preferences('brian') == {'pge': 14}


@pytest.fixture
def source(monkeypatch):
    bill = replace(plan(), id='variable-pge', kind='variable', source_label='PG&E', name='PG&E',
                   amount_cents=None, pull_day=22, cadence='monthly', pull_months=(), monthly_source=True, version='v1')
    client, _ = fixture([bill])
    for rows in (client.http_client.rows, client.http_client.formulas):
        rows['November'][0][2] = ''
    monkeypatch.setattr(storage, 'get_budget_spreadsheet_id_for_user', lambda *a: 'personal')
    monkeypatch.setattr('bookiebot.reimbursements.service.enabled', lambda: False)
    monkeypatch.setattr(checkin, 'read_workbook', lambda actor, today: storage.read_workbook(actor, today, client=client))
    monkeypatch.setattr(checkin, 'now_pacific', lambda: NOW)
    return SimpleNamespace(client=client, bill=bill)


def test_default_window_overdue_and_confirmation_stop_the_prompt(source, store):
    before = NOW - timedelta(days=1)
    assert not checkin.candidates(B, current=before, store=store)['bills']
    result = checkin.candidates(B, current=NOW, store=store)
    assert [(b['id'], b['date'], b['overdue']) for b in result['bills']] == [('variable-pge', '2026-11-22', False)]
    assert checkin.candidates(B, current=NOW + timedelta(days=9), store=store)['bills'][0]['overdue']
    source.client.http_client.rows['November'][0][2] = '152.08'
    assert not checkin.candidates(B, current=NOW, store=store)['bills']
    assert not source.client.http_client.sent


def test_custom_lead_off_cadence_future_and_stopped_plans(source, store):
    store.preference('brian', source.bill.id, 3)
    assert not checkin.candidates(B, current=NOW, store=store)['bills']
    assert checkin.candidates(B, current=NOW + timedelta(days=4), store=store)['bills']
    store.preference('brian', source.bill.id, None)
    assert not checkin.candidates(B, current=NOW + timedelta(days=9), store=store)['bills']
    store.preference('brian', source.bill.id, 30)
    for bill in (replace(source.bill, active=False), replace(source.bill, kind='fixed'),
                 replace(source.bill, pull_day=0), replace(source.bill, effective_from='2026-12'),
                 replace(source.bill, cadence='quarterly', pull_months=(1, 4, 7, 10))):
        source.client.http_client.rows[BILL_TAB] = encode([bill], BILL_TAB, [])
        assert not checkin.candidates(B, current=NOW, store=store)['bills']


def test_recorded_zero_is_confirmed_without_inventing_a_payment_or_new_invoice(source, store):
    from bookiebot.sheets.recurring_charges import BillCharge, CHARGES_TAB, encode_charges, source_anchor
    bill = source.bill
    charge = BillCharge(bill.id, '2026-11', '2026-11-01', bill.source_label, bill.category,
                       1, 1, 3, source_anchor(bill.id, '2026-11'), 15208, True, payer_owner='brian')
    source.client.http_client.rows[CHARGES_TAB] = encode_charges([charge], [])
    source.client.http_client.formulas[CHARGES_TAB] = encode_charges([charge], [])
    source.client.http_client.properties[CHARGES_TAB] = {'title':CHARGES_TAB,'sheetId':20}
    assert not checkin.candidates(B, current=NOW, store=store)['bills']
    snapshot = checkin.read_workbook(B, NOW.date())
    info = snapshot.charge(bill, '2026-11')
    assert info['recorded'] and info['status'] == 'confirmed'
    assert info['date'] == '2026-11-22' and info['billAmountCents'] == 0
    assert not source.client.http_client.sent


def test_unsplit_invoice_correction_displays_current_source_not_initial_charge_amount(source):
    from bookiebot.sheets.recurring_charges import BillCharge, CHARGES_TAB, encode_charges, source_anchor
    bill = source.bill
    charge = BillCharge(bill.id, '2026-11', '2026-11-15', bill.source_label, bill.category,
                       1, 1, 3, source_anchor(bill.id, '2026-11'), 12567, True, payer_owner='brian')
    for tables in (source.client.http_client.rows, source.client.http_client.formulas):
        tables[CHARGES_TAB] = encode_charges([charge], [])
        tables['November'][0][2] = '126.78'
    source.client.http_client.properties[CHARGES_TAB] = {'title':CHARGES_TAB,'sheetId':20}
    snapshot = checkin.read_workbook(B, NOW.date())
    info = snapshot.charge(bill, '2026-11')
    assert info['amountCents'] == info['billAmountCents'] == 12678
    assert info['status'] == 'confirmed' and info['date'] == '2026-11-22'
    assert not source.client.http_client.sent


def test_checkin_window_uses_the_clamped_payment_day_in_leap_february(source, store):
    bill = replace(source.bill, pull_day=31)
    source.client.http_client.rows[BILL_TAB] = encode([bill], BILL_TAB, [])
    for tables in (source.client.http_client.rows, source.client.http_client.formulas):
        tables['February'] = [['', bill.source_label, '']]
    source.client.http_client.properties['February'] = {'title':'February','sheetId':21}
    assert not checkin.candidates(B, current=datetime(2028,2,21,12,tzinfo=PACIFIC_TZ), store=store)['bills']
    result = checkin.candidates(B, current=datetime(2028,2,22,12,tzinfo=PACIFIC_TZ), store=store)
    assert result['bills'][0]['date'] == '2028-02-29'


def test_recipient_or_ambiguous_responsibility_never_gets_amount_entry(source, store, monkeypatch):
    allocation = {'id':'utility', 'payerOwner':'hannah', 'partnerOwner':'brian', 'sourceWorksheet':'income',
                  'sourceYear':2026, 'sourceSheetTitle':'October', 'partnerSourceLabel':'PG&E',
                  'category':'PG&E', 'sourceValues':{'item':'PG&E'}, 'item':'PG&E', 'version':'1'}
    monkeypatch.setattr('bookiebot.reimbursements.service.enabled', lambda: True)
    ledger = {'allocations':[allocation], 'events':[]}
    monkeypatch.setattr('bookiebot.reimbursements.service.build_reimbursement_store', lambda: SimpleNamespace(snapshot=lambda *a, **kw: ledger))
    assert not checkin.candidates(B, current=NOW, store=store)['bills']
    with pytest.raises(BillValidation, match='payer'):
        checkin.preference(B, {'id':source.bill.id, 'leadDays':14}, store=store)
    ledger['allocations'].append({**allocation, 'id':'other', 'payerOwner':'brian', 'partnerOwner':'hannah'})
    assert not checkin.candidates(B, current=NOW, store=store)['bills']
    assert not source.client.http_client.sent
