"""Pre-enrollment bill splits, with no billPlanId/partnerSourceLabel metadata."""
from copy import deepcopy
from dataclasses import replace
from datetime import datetime
from types import SimpleNamespace
from uuid import uuid4

import pytest

from unit_tests.reports.test_accounts import store
from unit_tests.reports.test_shared_bills import catalog, people, BRIAN, HANNAH
from bookiebot.reports import shared_bills, shared_bill_forecast
from bookiebot.reports.accounts import AccountConflict
from bookiebot.sheets import recurring_storage
from bookiebot.sheets.recurring import BILL_TAB, BillPlan
from bookiebot.sheets.routing import PACIFIC_TZ


@pytest.fixture
def legacy(catalog, monkeypatch):
    payer, member = people(catalog)
    originals, locals_, bills, allocations = [], [], [], []
    # Rent is already shared; the utility invitations have not been accepted.
    for name, kind, day, gross, share in [('Rent', 'fixed', 1, 300000, 100000),
            ('Water', 'variable', 18, 9000, 3000), ('PG&E', 'variable', 22, 15000, 5000),
            ('Recology', 'variable', 20, 12000, 4000)]:
        identity = name.lower().replace('&', '')
        plan = BillPlan('payer-' + identity, kind, name, gross if kind == 'fixed' else None,
            'quarterly' if name == 'Recology' else 'monthly', day,
            (2, 5, 8, 11) if name == 'Recology' else (), 'rent' if name == 'Rent' else 'bills_utilities',
            'Checking', name, BILL_TAB, effective_from='2026-01', effective_until='2026-12',
            monthly_source=True, version=identity + '-original')
        future = replace(plan, effective_from='2026-12', effective_until='9999-12', split_method='equal', version=identity+'-future')
        local = replace(plan, id='local-'+identity, name='Apartment' if name == 'Rent' else name,
            amount_cents=None, pull_day=0, pull_months=(), effective_until='9999-12', request_id='baseline')
        originals.extend([plan, future]); locals_.append(local)
        allocation = dict(id='allocation-'+identity, payerOwner='brian', partnerOwner='hannah',
            sourceWorksheet='income', sourceYear=2026, sourceSheetTitle='November', sourceRow=17+len(allocations),
            sourceActionId='original-'+identity, sourceValues={'item': name, 'amount': str(gross/100)},
            category=name.lower(), expenseDate='2026-11-01', grossCents=gross, payerShareCents=gross-share,
            partnerShareCents=share, settledCents=share, outstandingCents=0, lifecycle='active')
        allocations.append(allocation)
        public = {**plan.public('2026-11'), 'sourceLabel': name, 'prediction': None,
            'nextChange': {**future.public('2026-12'), 'sourceLabel': name},
            'charge': {'available': True, 'month': '2026-11', 'amountCents': gross-share,
                'billAmountCents': gross, 'recorded': True, 'date': f'2026-11-{day:02d}',
                'status': 'paid' if day == 1 else 'confirmed'}}
        bills.append(public)
        catalog.apply(actor=payer, payer=payer, member=member, plan_id=plan.id, member_plan_id='',
            action='invite', revision=0, request_id=uuid4().hex, fingerprint='fixture')
        if name == 'Rent':
            catalog.apply(actor=member, payer=payer, member=member, plan_id=plan.id, member_plan_id='',
                action='accept', revision=1, request_id=uuid4().hex, fingerprint='fixture-accept')
    own = {'month': '2026-11', 'bills': [{**p.public('2026-11'), 'sourceLabel': p.source_label,
        'nextChange': None} for p in locals_]}
    source = {'month': '2026-11', 'bills': bills}
    ledger = {'allocations': allocations, 'events': [dict(id='receipt-'+a['id'], allocationId=a['id'],
        status='confirmed', amountCents=a['settledCents'], date='2026-11-01') for a in allocations]}
    snapshots = {BRIAN: SimpleNamespace(settings=SimpleNamespace(plans=originals), allocations=allocations, rows={}),
        HANNAH: SimpleNamespace(settings=SimpleNamespace(plans=locals_, records=lambda: locals_), allocations=allocations)}
    monkeypatch.setattr(recurring_storage, 'read_workbook', lambda actor, *_: snapshots[actor])
    monkeypatch.setattr(shared_bill_forecast, 'build_store', lambda: catalog)
    monkeypatch.setattr(shared_bill_forecast, 'now_pacific', lambda: datetime(2026, 11, 16, tzinfo=PACIFIC_TZ))
    load = lambda actor: source if actor == BRIAN else own
    return SimpleNamespace(own=own, source=source, ledger=ledger, load=load, locals=locals_,
        snapshots=snapshots, catalog=catalog)


def test_legacy_mixed_invitations_coalesce_without_rewriting_money_or_acceptance(legacy):
    before = deepcopy((legacy.own, legacy.source, legacy.ledger))
    links = legacy.catalog.links(people(legacy.catalog)[1])
    result = shared_bills.enrich_listing(HANNAH, legacy.own, store=legacy.catalog,
        load=legacy.load, ledger_read=lambda _: legacy.ledger)
    assert len(result['bills']) == 4
    for bill in result['bills']:
        assert bill['readOnly'] and not bill['needsSetup']
        state = bill['sharing']['state']
        original = next(a for a in legacy.ledger['allocations'] if a['sourceValues']['item'] == bill['name'])
        assert state['memberShareCents'] == original['partnerShareCents']
        assert state['receivedCents'] == original['settledCents'] and state['remainingCents'] == 0
        assert state['repaymentStatus'] == 'settled'
        assert state['allocationIds'] == [original['id']]
        assert bill['sharing']['status'] == ('active' if bill['name'] == 'Rent' else 'pending')
        assert bill['charge']['amountCents'] == original['partnerShareCents']
    assert (legacy.own, legacy.source, legacy.ledger) == before
    assert legacy.catalog.links(people(legacy.catalog)[1]) == links, 'Read repair never auto-accepts or writes membership'


def test_legacy_acceptance_persists_verified_local_source_and_preserves_original_cycle(legacy):
    member = people(legacy.catalog)[1]
    for link in legacy.catalog.links(member):
        if link['status'] != 'pending':
            continue
        checked = shared_bills.review(HANNAH, {'action': 'accept', 'shareId': link['id']},
            store=legacy.catalog, load=legacy.load)
        assert checked['_memberPlanId'] == link['plan_id'].replace('payer-', 'local-')
        legacy.catalog.apply(actor=member, payer=checked['_payer'], member=member,
            plan_id=checked['_planId'], member_plan_id=checked['_memberPlanId'], action='accept',
            revision=1, request_id=uuid4().hex, fingerprint='accepted-fixture')
    values = shared_bill_forecast.forecast_inputs(HANNAH, ['2026-11', '2026-12'])
    november = [v for v in values if v.period == '2026-11']
    assert len(november) == 4
    for value in november:
        original = next(a for a in legacy.ledger['allocations'] if a['sourceValues']['item'] == value.name)
        assert value.target_cents == original['partnerShareCents'] and value.prediction is None
        assert value.member_plan_id == 'local-'+value.name.lower().replace('&', '')
        assert shared_bill_forecast.remaining_forecast(value,
            [SimpleNamespace(label=value.member_label, amount=original['partnerShareCents']/100)], value.member_label) == 0


@pytest.mark.parametrize('change', ['wrong-owner', 'wrong-sheet', 'wrong-plan', 'missing-action', 'ambiguous-payer', 'ambiguous-member', 'new-source'])
def test_legacy_link_resolution_rejects_unverified_or_ambiguous_sources(legacy, change):
    allocation = legacy.ledger['allocations'][0]
    if change == 'wrong-owner': allocation['payerOwner'] = 'someone-else'
    elif change == 'wrong-sheet': allocation['sourceWorksheet'] = 'expense'
    elif change == 'wrong-plan': allocation['billPlanId'] = 'unrelated-rent'
    elif change == 'missing-action': allocation.pop('sourceActionId')
    elif change == 'ambiguous-payer': legacy.source['bills'].append({**legacy.source['bills'][0], 'id': 'another-rent'})
    elif change == 'new-source': legacy.source['bills'][0]['sourceFrom'] = '2026-12'
    else: legacy.own['bills'].append({**legacy.own['bills'][0], 'id': 'another-local-rent'})
    result = shared_bills.enrich_listing(HANNAH, legacy.own, store=legacy.catalog,
        load=legacy.load, ledger_read=lambda _: legacy.ledger)
    assert any(b['id'] == 'local-rent' for b in result['bills']), 'An unverified source must not disappear'
    if change not in {'ambiguous-member'}:
        rent = next(b for b in result['bills'] if b.get('readOnly') and b['name'] == 'Rent')
        assert rent['sharing']['state']['allocationIds'] == []


def test_legacy_acceptance_keeps_independent_future_plan_guard(legacy):
    local = legacy.locals[1]
    legacy.locals[1] = replace(local, amount_cents=1000, pull_day=18)
    member = people(legacy.catalog)[1]
    link = next(l for l in legacy.catalog.links(member) if l['plan_id'] == 'payer-water')
    with pytest.raises(AccountConflict, match='separate recurring setup'):
        shared_bills.review(HANNAH, {'action': 'accept', 'shareId': link['id']}, store=legacy.catalog, load=legacy.load)


def test_read_keeps_independent_local_rule_beyond_first_scheduled_change(legacy):
    # The listing carries this guard from all saved versions, even when the
    # first nextChange is a zero/unscheduled version and a later one is positive.
    legacy.own['bills'][0]['hasFutureAmount'] = True
    result = shared_bills.enrich_listing(HANNAH, legacy.own, store=legacy.catalog,
        load=legacy.load, ledger_read=lambda _: legacy.ledger)
    assert any(b['id'] == 'local-rent' for b in result['bills'])


def test_existing_accepted_legacy_rent_forecast_resolves_renamed_recipient_source(legacy):
    values = shared_bill_forecast.forecast_inputs(HANNAH, ['2026-11'])
    assert len(values) == 1 and values[0].member_plan_id == 'local-rent'
    assert values[0].member_label.lower() == 'rent' and values[0].target_cents == 100000
    assert values[0].date == '2026-11-01'


@pytest.mark.parametrize('pending_first', [False, True])
def test_another_bill_cannot_adopt_already_accepted_unbound_legacy_source(legacy, pending_first):
    payer, member = people(legacy.catalog)
    other = {**legacy.source['bills'][0], 'id': 'different-bill', 'sourceLabel': 'Other rent'}
    legacy.source['bills'].append(other)
    legacy.ledger['allocations'].append({**legacy.ledger['allocations'][0], 'id': 'different-allocation',
        'billPlanId': other['id'], 'partnerSourceLabel': 'Rent'})
    invitation = legacy.catalog.apply(actor=payer, payer=payer, member=member, plan_id=other['id'], member_plan_id='',
        action='invite', revision=0, request_id=uuid4().hex, fingerprint='other-fixture')
    if pending_first:
        with legacy.catalog.access.connect(write=True) as db:
            db.execute('UPDATE app_bill_shares SET created_at = 0 WHERE id = ?', (invitation['id'],))
    result = shared_bills.enrich_listing(HANNAH, legacy.own, store=legacy.catalog,
        load=legacy.load, ledger_read=lambda _: legacy.ledger)
    assert len(result['bills']) == 5, 'A pending conflict must not make Bills unavailable'
    conflict = next(b for b in result['bills'] if b['id'] == 'shared:'+invitation['id'])
    assert conflict['sharing']['status'] == 'pending'
    decline = shared_bills.review(HANNAH, {'action': 'decline', 'shareId': invitation['id']}, store=legacy.catalog, load=legacy.load)
    assert decline['action'] == 'decline' and decline['shareId'] == invitation['id']
    with pytest.raises(AccountConflict, match='different shared bill'):
        shared_bills.review(HANNAH, {'action': 'accept', 'shareId': invitation['id']}, store=legacy.catalog, load=legacy.load)


@pytest.mark.parametrize('lifecycle,settled,outstanding,cleared', [('active', 1000, 2000, 0),
    ('active', 1000, 0, 2000), ('void', 0, 0, 0)])
def test_legacy_partial_cleared_and_voided_occurrences_retain_original_state(legacy, lifecycle, settled, outstanding, cleared):
    value = legacy.ledger['allocations'][0]
    value.update(lifecycle=lifecycle, partnerShareCents=3000, settledCents=settled,
        outstandingCents=outstanding, clearedCents=cleared)
    result = shared_bills.enrich_listing(HANNAH, legacy.own, store=legacy.catalog,
        load=legacy.load, ledger_read=lambda _: legacy.ledger)
    state = next(b for b in result['bills'] if b.get('readOnly') and b['name'] == 'Rent')['sharing']['state']
    assert state['repaymentStatus'] == ('cancelled' if lifecycle == 'void' else 'cleared' if cleared else 'partial')
    assert state['receivedCents'] == settled and state['remainingCents'] == outstanding
    assert state['clearedCents'] == cleared


def test_legacy_report_current_calendar_and_projection_count_reimbursed_cash_once(legacy, monkeypatch):
    from bookiebot.reimbursements import service
    from bookiebot.reports import expense_breakdown as report
    from bookiebot.sheets.recurring_rows import encode
    from unit_tests.support.sheets_repo_stub import InMemoryWorksheet
    member = people(legacy.catalog)[1]
    for link in legacy.catalog.links(member):
        if link['status'] != 'pending':
            continue
        checked = shared_bills.review(HANNAH, {'action': 'accept', 'shareId': link['id']}, store=legacy.catalog, load=legacy.load)
        legacy.catalog.apply(actor=member, payer=checked['_payer'], member=member, plan_id=checked['_planId'],
            member_plan_id=checked['_memberPlanId'], action='accept', revision=1, request_id=uuid4().hex, fingerprint='report-fixture')
    monkeypatch.setattr(report, 'now_pacific', lambda: datetime(2026, 11, 16, tzinfo=PACIFIC_TZ))
    ledger = {**legacy.ledger, 'projectionPending': False}
    monkeypatch.setattr(service, 'enabled', lambda: True)
    monkeypatch.setattr(service, 'snapshot', lambda _: ledger)
    rows = [['', 'Income'], ['', 'Date', 'Source', 'Amount'], ['', '11/1/2026', 'Paycheck', '3000']]
    rows.extend(['', a['sourceValues']['item'], str(a['partnerShareCents']/100)] for a in ledger['allocations'])
    rows.extend([['', 'Total Needs', '1120'], ['', 'Total Wants', '0']])
    source = report.ReportWorksheets(shared_expenses=InMemoryWorksheet([]), personal_budget=InMemoryWorksheet(rows),
        bill_schedule=InMemoryWorksheet(encode(legacy.locals, BILL_TAB, [])),
        shared_bill_forecasts=shared_bill_forecast.forecast_inputs(HANNAH, ['2026-11', '2026-12']))
    before = deepcopy(ledger)
    result = report.build_expense_breakdown_report(actor_key=HANNAH, owner_name='Hannah', persons=['Hannah'],
        month=report.BudgetMonth(2026, 11), worksheets=source)
    assert len(result.payments) == 4 and not result.queued_bills
    assert all(p.date == '2026-11-01' for p in result.payments)
    assert not any(e.shared_forecast for e in result.calendar_events), 'Settled shares cannot become another projected bill'
    payload = report.expense_breakdown_client_payload(result)
    assert payload['modeViews']['current']['metrics']['totalExpenses'] == 1120
    assert payload['modeViews']['projected']['metrics']['totalExpenses'] == 1120
    assert ledger == before
