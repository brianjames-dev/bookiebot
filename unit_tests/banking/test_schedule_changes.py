"""Isolated schedule source/mirror/payment writes and recoverable bank claims."""
from copy import deepcopy
from dataclasses import replace
from types import SimpleNamespace

import pytest
from gspread.exceptions import WorksheetNotFound
from openpyxl.utils.cell import coordinate_to_tuple

from bookiebot.banking import schedule_changes as change
from bookiebot.banking.crypto import TokenCipher
from bookiebot.banking.reconciliation import ActionLogCandidate
from bookiebot.banking.store import BankStore
from bookiebot.sheets.bills import BILL_SCHEDULE_HEADERS
from bookiebot.sheets.routing import now_pacific
from bookiebot.sheets.undo import LoggedAction, UndoAction
from bookiebot.reimbursements.store import ReimbursementStore
from bookiebot.reports.app_access import AppAccessStore
from bookiebot.reimbursements import projection

ACTOR = '676638528590970917'


class Sheet:
    def __init__(self, title, rows, book):
        self.title, self.rows, self.spreadsheet = title, rows, book
        self.id = title
        self.spreadsheet_id = 'isolated-budget'

    def get_all_values(self, **kwargs):
        return deepcopy(self.rows)

    def cell(self, row, col):
        return SimpleNamespace(value=self.rows[row - 1][col - 1])


class Book:
    def __init__(self):
        self.sheets, self.writes, self.lose_response = {}, 0, False

    def add(self, title, rows):
        self.sheets[title] = Sheet(title, rows, self)

    def values_batch_update(self, body):
        self.writes += 1
        for entry in body['data']:
            title, cell = entry['range'].split('!')
            row, col = coordinate_to_tuple(cell)
            self.sheets[title.strip("'")].rows[row - 1][col - 1] = str(entry['values'][0][0])
        if self.lose_response:
            raise TimeoutError('Response lost after atomic sheet write')


@pytest.fixture
def setup(tmp_path, monkeypatch):
    today = now_pacific().date()
    book = Book()
    book.add('Subscriptions', [['Monthly Needs'], ['Recurring', 'Name', 'Amount'], [str(today.day), 'Cloud', '9.99']])
    book.add('_BookieBot Subscription Schedule', [
        ['cadence', 'name', 'amount', 'pull_day', 'pull_month', 'source_range', 'updated_at'],
        ['monthly', 'Cloud', '9.99', str(today.day), '', 'Subscriptions!A3:C3', ''],
    ])
    book.add('_BookieBot Bill Schedule', [BILL_SCHEDULE_HEADERS + ['tracking_mode'],
        ['water', 'Water', 'monthly', str(today.day), '', 'Water', '', '', '', '90.00', 'manual']])
    book.add(today.strftime('%B'), [['', 'Water', '100.00']])
    def worksheet(title):
        if title not in book.sheets:
            raise WorksheetNotFound(title)
        return book.sheets[title]
    monkeypatch.setattr(change, 'get_existing_personal_worksheet', worksheet)
    history, active, updates = [], [], []
    ledger = ReimbursementStore(AppAccessStore(tmp_path / 'shared.sqlite3'))
    ledger.initialize()
    monkeypatch.setenv('BOOKIEBOT_REIMBURSEMENTS_ENABLED', 'true')
    monkeypatch.setattr(change, 'build_reimbursement_store', lambda: ledger)
    monkeypatch.setattr(change.reimbursements, 'build_reimbursement_store', lambda: ledger)
    monkeypatch.setattr(change, 'read_active_logged_actions', lambda actor: active)
    monkeypatch.setattr(change, 'read_logged_action_history', lambda actor: history)
    def record(actor, action):
        logged = LoggedAction('split-action' if action.metadata.get('type') == 'split' else 'new-payment', today.isoformat(), ACTOR, action)
        active.append(logged); history.append(logged)
        return logged.id
    monkeypatch.setattr(change, 'record_undo_action', record)
    monkeypatch.setattr('bookiebot.sheets.undo.record_undo_action', record)
    monkeypatch.setattr(change, 'active_logged_action_by_id', lambda actor, identity: next((a for a in active if a.id == identity), None))
    monkeypatch.setattr('bookiebot.sheets.routing.get_budget_spreadsheet_id_for_user', lambda *args: 'isolated-budget')
    def project(store, *, allocation_ids):
        setup_data.projections += 1
        if setup_data.projection_failure:
            return False
        for identity in allocation_ids:
            value = store.get_allocation(identity)
            book.sheets[today.strftime('%B')].rows[0][2] = f"{(value['grossCents'] - value['settledCents']) / 100:.2f}"
            store.mark_projected(identity, value['version'])
        return True
    monkeypatch.setattr(projection, 'sync_pending', project)
    def update(actor, *, action_id, updates: dict, metadata_extra):
        item = next(item for item in active if item.id == action_id)
        item.action.new_values = [updates['amount']]
        book.sheets[today.strftime('%B')].rows[0][2] = updates['amount']
        history.append(LoggedAction('correction', today.isoformat(), ACTOR, UndoAction(
            worksheet='income', kind='restore_cells', row=1, columns=[3], previous_values=['100.00'],
            new_values=[updates['amount']], description='Updated payment',
            metadata={'type': 'update', 'source_type': 'payment', **metadata_extra})))
        setup_data.updates.append(action_id)
        return True, 'Updated'
    monkeypatch.setattr(change, 'update_recent_action', update)
    store = BankStore(tmp_path / 'bank.sqlite3', TokenCipher('test'))
    store.initialize()
    def seed(kind='subscription', identity='first', bank_date=None):
        amount = 12.99 if kind == 'subscription' else 125
        store.upsert_transactions([dict(transaction_id=identity, date=bank_date or today.isoformat(),
            name='Cloud' if kind == 'subscription' else 'Water', amount=amount, pending=False)], 'brian')
        tx = next(tx for tx in store.recent_transactions('brian') if tx.provider_transaction_id == identity)
        item = store.upsert_reconciliation_item(owner_key='brian', transaction=tx,
            classification='subscription' if kind == 'subscription' else 'expense', status='needs_review', confidence=0)
        ref = f'Subscriptions!A3:C3#pull={today}' if kind == 'subscription' else f'_BookieBot Bill Schedule!A2:K2#pull={today:%Y-%m}'
        candidate = ActionLogCandidate(f'schedule:{kind}:{ref}', ref, 'schedule', today,
            9.99 if kind == 'subscription' else 100, f'Cloud ({kind})' if kind == 'subscription' else 'Water (bill)', .8, 'Scheduled', True)
        return item, candidate
    setup_data = SimpleNamespace(book=book, store=store, service=SimpleNamespace(store=store), seed=seed,
        active=active, history=history, updates=[], ledger=ledger, projections=0, projection_failure=False)
    return setup_data


def preview(data, item, candidate, future=False, split='none'):
    return change.prepare_schedule_change('brian', ACTOR, item, candidate, update_future=future, split_method=split)


def apply(data, item, candidate, plan, future=False, split='none'):
    return change.apply_schedule_change(data.service, 'brian', ACTOR, item, candidate,
        plan['fingerprint'], update_future=future, split_method=split)


def test_subscription_updates_visible_and_normalized_amount_once(setup):
    item, candidate = setup.seed()
    plan = preview(setup, item, candidate)
    assert setup.book.writes == 0
    assert 'Future' in plan['description'] and plan['canUpdateFuture'] is False
    result = apply(setup, item, candidate, plan)
    assert result.status == 'completed'
    assert float(setup.book.sheets['Subscriptions'].rows[2][2]) == 12.99
    assert float(setup.book.sheets['_BookieBot Subscription Schedule'].rows[1][2]) == 12.99
    saved = setup.store.get_reconciliation_item('brian', item.id)
    assert saved.status == 'confirmed' and saved.matched_sheet_ref == candidate.sheet_ref
    assert saved.matched_action_log_id is None
    assert apply(setup, item, candidate, plan).status == 'completed' and setup.book.writes == 1
    events = setup.store.reconciliation_events('brian', item.id)
    assert [event['event_type'] for event in events] == ['schedule_amount_updated']


@pytest.mark.parametrize('future', [False, True])
def test_manual_bill_changes_actual_and_only_explicit_future_estimate(setup, future):
    item, candidate = setup.seed('bill')
    plan = preview(setup, item, candidate, future)
    assert plan['canUpdateFuture'] and setup.book.writes == 0
    result = apply(setup, item, candidate, plan, future)
    assert result.status == 'completed'
    assert float(setup.book.sheets[now_pacific().strftime('%B')].rows[0][2]) == 125
    assert float(setup.book.sheets['_BookieBot Bill Schedule'].rows[1][9]) == (125 if future else 90)
    assert len(setup.history) == 1 and setup.history[0].action.previous_values == ['100.00']
    saved = setup.store.get_reconciliation_item('brian', item.id)
    assert saved.matched_action_log_id == 'new-payment' and candidate.sheet_ref in saved.matched_sheet_ref


def test_bill_correction_reuses_canonical_action_update(setup):
    item, candidate = setup.seed('bill')
    action = LoggedAction('old-payment', now_pacific().date().isoformat(), ACTOR, UndoAction(
        worksheet='income', kind='restore_cells', row=1, columns=[3], previous_values=[''],
        new_values=['100.00'], metadata={'type': 'payment', 'category': 'Water'}, description='Water payment'))
    setup.active.append(action); setup.history.append(action)
    result = apply(setup, item, candidate, preview(setup, item, candidate))
    assert result.status == 'completed' and setup.updates == ['old-payment']
    assert setup.book.writes == 0
    assert setup.store.get_reconciliation_item('brian', item.id).matched_action_log_id == 'old-payment'


@pytest.mark.parametrize('mutation', ['amount', 'mirror', 'identity', 'recurrence'])
def test_changed_source_or_mirror_cannot_write(setup, mutation):
    item, candidate = setup.seed()
    plan = preview(setup, item, candidate)
    if mutation == 'amount':
        setup.book.sheets['Subscriptions'].rows[2][2] = '8.99'
    elif mutation == 'mirror':
        setup.book.sheets['_BookieBot Subscription Schedule'].rows[1][2] = '8.99'
    elif mutation == 'identity':
        setup.book.sheets['Subscriptions'].rows[2][1] = 'Different service'
    else:
        setup.book.sheets['Subscriptions'].rows[2][0] = str(now_pacific().day % 28 + 1)
    with pytest.raises(change.ScheduleChangeConflict):
        apply(setup, item, candidate, plan)
    assert setup.book.writes == 0 and setup.store.get_import_operation('brian', item.id) is None


def test_lost_write_response_recovers_without_another_writer(setup):
    item, candidate = setup.seed()
    plan = preview(setup, item, candidate)
    setup.book.lose_response = True
    assert apply(setup, item, candidate, plan).status == 'needs_recovery'
    assert setup.book.writes == 1
    operation = setup.store.get_import_operation('brian', item.id)
    assert operation.status == 'needs_recovery'
    assert change.recover_schedule_change(setup.store, operation).status == 'completed'
    assert setup.book.writes == 1


def test_partial_write_stays_reserved_and_cannot_be_retried(setup):
    item, candidate = setup.seed()
    plan = preview(setup, item, candidate)
    def partial(body):
        setup.book.writes += 1
        setup.book.sheets['Subscriptions'].rows[2][2] = '12.99'
        raise TimeoutError('Partial write')
    setup.book.values_batch_update = partial
    assert apply(setup, item, candidate, plan).status == 'needs_recovery'
    op = setup.store.get_import_operation('brian', item.id)
    assert change.recover_schedule_change(setup.store, op).status == 'needs_recovery'
    assert apply(setup, item, candidate, plan).status == 'needs_recovery'
    assert setup.book.writes == 1
    other, other_candidate = setup.seed(identity='second')
    request = __import__('json').loads(op.request_json)
    request.update(expected_last_seen_at=other.last_seen_at, expected_updated_at=other.transaction.updated_at)
    claimed, success = setup.store.claim_reconciliation_import('brian', other.id,
        actor_key=ACTOR, operation_id='second', kind='schedule_adjustment', request=request)
    assert claimed is None and not success
    assert setup.store.confirm_reconciliation_item('brian', other.id,
        matched_sheet_ref=candidate.sheet_ref, expected_item=other) is None


@pytest.mark.parametrize('invalid', ['pending', 'owner', 'month', 'formula'])
def test_invalid_or_calculated_sources_never_write(setup, invalid):
    item, candidate = setup.seed()
    if invalid == 'pending':
        item = replace(item, transaction=replace(item.transaction, pending=True))
    elif invalid == 'owner':
        item = replace(item, owner_key='hannah')
    elif invalid == 'month':
        item = replace(item, transaction=replace(item.transaction, date='2020-01-01'))
    else:
        setup.book.sheets['Subscriptions'].rows[2][2] = '=SUM(1,2)'
    with pytest.raises((change.ScheduleChangeConflict, ValueError)):
        preview(setup, item, candidate)
    assert setup.book.writes == 0


def test_source_and_mirror_prices_are_both_explicit_in_the_review(setup):
    item, candidate = setup.seed()
    setup.book.sheets['Subscriptions'].rows[2][2] = '10.99'
    plan = preview(setup, item, candidate)
    assert plan['oldAmountCents'] == 1099 and plan['scheduleAmountCents'] == 999
    assert apply(setup, item, candidate, plan).status == 'completed'


def test_source_change_after_claim_releases_only_an_unwritten_claim(setup, monkeypatch):
    item, candidate = setup.seed()
    plan = preview(setup, item, candidate)
    claim = setup.store.claim_reconciliation_import
    def changed(*args, **kwargs):
        result = claim(*args, **kwargs)
        setup.book.sheets['Subscriptions'].rows[2][2] = '11.99'
        return result
    monkeypatch.setattr(setup.store, 'claim_reconciliation_import', changed)
    with pytest.raises(change.ScheduleChangeConflict, match='no amounts were changed'):
        apply(setup, item, candidate, plan)
    assert setup.book.writes == 0 and setup.store.get_import_operation('brian', item.id) is None
    assert setup.store.get_reconciliation_item('brian', item.id).status == 'needs_review'
    assert setup.store.reconciliation_events('brian', item.id)[0]['event_type'] == 'schedule_amount_change_cancelled'


def test_unrecorded_bill_can_be_recorded_without_creating_an_expense(setup):
    item, candidate = setup.seed('bill')
    setup.book.sheets[now_pacific().strftime('%B')].rows[0][2] = ''
    candidate = replace(candidate, amount=90, amount_recorded=False)
    plan = preview(setup, item, candidate)
    assert plan['oldAmountCents'] == 0
    assert apply(setup, item, candidate, plan).status == 'completed'
    assert setup.history[0].action.worksheet == 'income' and setup.history[0].action.metadata['type'] == 'payment'


def test_completed_operation_cannot_rewrite_an_intentionally_reopened_payment(setup):
    item, candidate = setup.seed()
    assert apply(setup, item, candidate, preview(setup, item, candidate)).status == 'completed'
    setup.store.reopen_reconciliation_item('brian', item.id)
    op = setup.store.get_import_operation('brian', item.id)
    assert change.recover_schedule_change(setup.store, op).status == 'rejected'
    assert setup.book.writes == 1


@pytest.mark.parametrize('source_ref', ['Subscriptions!A2:G2', ''])
def test_normalized_visible_subscription_layout_updates_by_header(setup, source_ref):
    item, candidate = setup.seed()
    day = str(now_pacific().day)
    setup.book.sheets['Subscriptions'].rows = [
        ['cadence', 'name', 'amount', 'pull_day', 'pull_month', 'source_range', 'updated_at'],
        ['monthly', 'Cloud', '9.99', day, '', source_ref, ''],
    ]
    setup.book.sheets['_BookieBot Subscription Schedule'].rows[1][5] = source_ref
    if not source_ref:
        from bookiebot.sheets.subscriptions import parse_visible_subscription_schedules
        sub = parse_visible_subscription_schedules(setup.book.sheets['Subscriptions'].rows)[0]
        source_ref = f'subscription:{sub.id}'
    candidate = replace(candidate, sheet_ref=source_ref + f'#pull={now_pacific().date()}',
                        action_id='schedule:subscription:' + source_ref)
    assert apply(setup, item, candidate, preview(setup, item, candidate)).status == 'completed'
    assert float(setup.book.sheets['Subscriptions'].rows[1][2]) == 12.99


def test_automatic_bill_updates_setting_and_verifies_formula_without_overwriting_it(setup):
    item, candidate = setup.seed('bill')
    setup.book.sheets['_BookieBot Bill Schedule'].rows[1][9:11] = ['100.00', 'automatic']
    month = setup.book.sheets[now_pacific().strftime('%B')]
    month.rows[0][2] = '=schedule_amount'
    def values(**kwargs):
        rows = deepcopy(month.rows)
        if kwargs.get('value_render_option') != 'FORMULA':
            rows[0][2] = setup.book.sheets['_BookieBot Bill Schedule'].rows[1][9]
        return rows
    month.get_all_values = values
    plan = preview(setup, item, candidate)
    assert not plan['canUpdateFuture'] and 'automatic' in plan['description']
    assert apply(setup, item, candidate, plan).status == 'completed'
    assert month.rows[0][2] == '=schedule_amount' and len(setup.history) == 0
    assert float(values()[0][2]) == 125


def test_large_scheduled_price_change_is_only_a_review_suggestion(setup):
    from bookiebot.banking.reconciliation import ScheduledPullCandidate, find_scheduled_pull_candidates, reconcile_transaction
    item, _ = setup.seed()
    bank = replace(item.transaction, name='Cloud', amount=100)
    pull = ScheduledPullCandidate('subscription', 'Cloud', 9.99, now_pacific().date(), 'Subscriptions!A3:C3')
    assert find_scheduled_pull_candidates(bank, [pull])
    assert reconcile_transaction(bank, scheduled_pulls=[pull]).status == 'needs_review'


def test_missing_optional_subscription_mirror_is_not_provisioned(setup):
    item, candidate = setup.seed()
    del setup.book.sheets['_BookieBot Subscription Schedule']
    assert apply(setup, item, candidate, preview(setup, item, candidate)).status == 'completed'
    assert '_BookieBot Subscription Schedule' not in setup.book.sheets


def test_saved_schedule_history_keeps_original_bank_amount_after_a_price_change(setup):
    from bookiebot.banking.service import BankingService
    from bookiebot.banking.reconciliation import ScheduledPullCandidate
    item, candidate = setup.seed()
    saved = setup.store.confirm_reconciliation_item('brian', item.id, matched_sheet_ref=candidate.sheet_ref, expected_item=item)
    pull = ScheduledPullCandidate('subscription', 'Cloud', 50, now_pacific().date(), 'Subscriptions!A3:C3')
    reported = BankingService._matched_report_candidate(setup.service, saved, {}, [pull])
    assert reported is not None and reported.amount == item.transaction.amount
    assert pull.amount == 50


def test_recovery_rejects_a_retargeted_workbook(setup):
    item, candidate = setup.seed()
    plan = preview(setup, item, candidate)
    setup.book.lose_response = True
    assert apply(setup, item, candidate, plan).status == 'needs_recovery'
    setup.book.sheets['Subscriptions'].spreadsheet_id = 'different-budget'
    assert change.recover_schedule_change(setup.store, setup.store.get_import_operation('brian', item.id)).status == 'needs_recovery'
    assert setup.book.writes == 1


def shared_bill(data, *, gross=10000, settled=0, method='income'):
    from unit_tests.reimbursements.test_store import payload
    from bookiebot.sheets.collaboration import split_amounts
    payer, partner = split_amounts(gross / 100, method, 'brian')
    value = data.ledger.register_allocation(payload(
        id='shared-water', sourceActionId='old-payment', splitActionId='old-split',
        item='Water', category='water', sourceWorksheet='income', sourceRow=1,
        expenseDate=now_pacific().date().isoformat(), sourceYear=now_pacific().year,
        sourceSheetTitle=now_pacific().strftime('%B'), sourceSpreadsheetId='isolated-budget',
        sourceColumnMap={'item': 2, 'amount': 3}, sourceValues={'item': 'Water', 'amount': f'{gross / 100:.2f}'},
        grossCents=gross, payerShareCents=round(payer * 100), partnerShareCents=round(partner * 100),
        settledCents=settled, method=method))
    data.ledger.mark_projected(value['id'], value['version'])
    data.book.sheets[now_pacific().strftime('%B')].rows[0][2] = f'{(gross - settled) / 100:.2f}'
    action = LoggedAction('old-payment', now_pacific().date().isoformat(), ACTOR, UndoAction(
        worksheet='income', kind='restore_cells', row=1, columns=[2, 3], previous_values=[''],
        new_values=[f'{gross / 100:.2f}'], metadata={'type': 'payment', 'category': 'water',
            'canonical_reimbursement': 'true', 'allocation_id': value['id']}, description='Water payment'))
    data.active.append(action); data.history.append(action)
    return data.ledger.get_allocation(value['id'])


@pytest.mark.parametrize('method', ['income', 'equal', 'none'])
def test_new_bill_reviews_gross_and_split_and_never_invents_receipts(setup, method):
    from bookiebot.sheets.collaboration import split_amounts
    item, candidate = setup.seed('bill')
    plan = preview(setup, item, candidate, split=method)
    shares = plan['sharing']
    assert shares['canChoose'] and shares['method'] == method
    assert shares['payerShareCents'] + shares['partnerShareCents'] == 12500
    assert shares['budgetAmountCents'] == 12500 and not setup.ledger.snapshot('brian')['allocations']
    assert apply(setup, item, candidate, plan, split=method).status == 'completed'
    assert setup.book.sheets[now_pacific().strftime('%B')].rows[0][2] in {'125.0', '125.00'}
    ledger = setup.ledger.snapshot('brian')
    assert not ledger['events']
    if method == 'none':
        assert not ledger['allocations']
    else:
        value = ledger['allocations'][0]
        assert value['method'] == method and value['grossCents'] == 12500 and value['settledCents'] == 0
        assert (value['payerShareCents'], value['partnerShareCents']) == tuple(round(a * 100) for a in split_amounts(125, method, 'brian'))
        assert value['projectedVersion'] == value['version']
        assert setup.store.get_reconciliation_item('brian', item.id).matched_action_log_id == value['sourceActionId']
    assert apply(setup, item, candidate, plan, split=method).status == 'completed'
    assert len(setup.ledger.snapshot('brian')['allocations']) == (method != 'none')


def test_supported_bill_defaults_to_income_but_requires_matching_review(setup):
    item, candidate = setup.seed('bill')
    plan = change.prepare_schedule_change('brian', ACTOR, item, candidate)
    assert plan['sharing']['method'] == 'income'
    assert plan['sharing']['payerShareCents'] == 8091 and plan['sharing']['partnerShareCents'] == 4409
    with pytest.raises(change.ScheduleChangeConflict):
        apply(setup, item, candidate, plan, split='none')
    assert setup.book.writes == 0


def test_new_shared_bill_uses_bank_date_without_changing_logged_field_order(setup):
    bank_date = now_pacific().date().replace(day=1).isoformat()
    item, candidate = setup.seed('bill', bank_date=bank_date)
    assert apply(setup, item, candidate, preview(setup, item, candidate, split='income'), split='income').status == 'completed'
    value = setup.ledger.snapshot('brian')['allocations'][0]
    assert value['expenseDate'] == bank_date and value['category'] == 'water'
    split = next(entry for entry in setup.history if entry.action.metadata['type'] == 'split')
    fields = __import__('json').loads(split.action.metadata['display_fields'])
    assert dict(zip(fields, split.action.new_values)) == {'amount': '125.00', 'item': 'Water'}


@pytest.mark.parametrize('method', ['income', 'equal'])
def test_existing_bill_preserves_method_and_changes_full_gross_through_ledger(setup, method):
    item, candidate = setup.seed('bill')
    before = shared_bill(setup, method=method)
    plan = preview(setup, item, candidate, split='none')
    assert not plan['sharing']['canChoose'] and plan['sharing']['method'] == method
    assert apply(setup, item, candidate, plan, split='none').status == 'completed'
    after = setup.ledger.get_allocation(before['id'])
    assert after['grossCents'] == 12500 and after['method'] == method
    assert after['payerShareCents'] + after['partnerShareCents'] == 12500
    assert after['sourceRevision']['before']['grossCents'] == 10000
    assert after['version'] == before['version'] + 1 and after['version'] == after['projectedVersion']
    assert setup.projections == 1 and not setup.updates and setup.book.writes == 0
    assert not setup.ledger.snapshot('brian')['events']


def test_already_received_bill_matches_full_bank_amount_without_rewriting_net_cell(setup):
    item, candidate = setup.seed('bill')
    before = shared_bill(setup, gross=12500, settled=3000)
    candidate = replace(candidate, amount=95)
    plan = preview(setup, item, candidate, True)
    assert plan['sharing']['oldGrossCents'] == 12500
    assert plan['sharing']['budgetAmountCents'] == 9500 and plan['sharing']['settledCents'] == 3000
    assert apply(setup, item, candidate, plan, True).status == 'completed'
    assert setup.ledger.get_allocation(before['id']) == before
    assert setup.book.sheets[now_pacific().strftime('%B')].rows[0][2] == '95.00'
    assert float(setup.book.sheets['_BookieBot Bill Schedule'].rows[1][9]) == 125
    assert not setup.projections and not setup.updates


@pytest.mark.parametrize('guard', ['settled', 'pending', 'projection', 'missing_action', 'other_payer'])
def test_bill_split_guards_run_before_any_writer_or_claim(setup, guard):
    from unit_tests.reimbursements.test_store import payment
    item, candidate = setup.seed('bill')
    value = shared_bill(setup, settled=1000 if guard == 'settled' else 0)
    if guard == 'pending':
        setup.ledger.command('hannah', payment(value, 100, 'report_payment'))
    elif guard == 'projection':
        setup.ledger.attach_source(value['id'], {'sourceRow': 2})
    elif guard == 'missing_action':
        setup.active.clear()
    elif guard == 'other_payer':
        snapshot = setup.ledger.snapshot
        def opposite(*args, **kwargs):
            result = snapshot(*args, **kwargs)
            result['allocations'][0]['payerOwner'] = 'hannah'
            return result
        setup.ledger.snapshot = opposite
    if guard == 'settled':
        candidate = replace(candidate, amount=90)
    with pytest.raises(change.ScheduleChangeConflict):
        preview(setup, item, candidate)
    assert setup.book.writes == 0 and setup.projections == 0
    assert setup.store.get_import_operation('brian', item.id) is None


def test_bill_projection_failure_retains_claim_and_readonly_verification_waits_for_shared(setup):
    item, candidate = setup.seed('bill')
    value = shared_bill(setup)
    plan = preview(setup, item, candidate)
    setup.projection_failure = True
    assert apply(setup, item, candidate, plan).status == 'needs_recovery'
    op = setup.store.get_import_operation('brian', item.id)
    after = setup.ledger.get_allocation(value['id'])
    assert after['grossCents'] == 12500 and after['projectedVersion'] != after['version']
    assert change.recover_schedule_change(setup.store, op).status == 'needs_recovery'
    assert apply(setup, item, candidate, plan).status == 'needs_recovery' and setup.projections == 1
    setup.projection_failure = False
    projection.sync_pending(setup.ledger, allocation_ids={value['id']})
    assert change.recover_schedule_change(setup.store, op).status == 'completed'
    assert setup.ledger.get_allocation(value['id'])['version'] == after['version']
    assert not setup.book.writes


def test_new_bill_with_failed_split_projection_cannot_be_completed_as_unsplit(setup):
    item, candidate = setup.seed('bill')
    plan = preview(setup, item, candidate, split='income')
    setup.projection_failure = True
    assert apply(setup, item, candidate, plan, split='income').status == 'needs_recovery'
    operation = setup.store.get_import_operation('brian', item.id)
    assert len(setup.ledger.snapshot('brian')['allocations']) == 1
    assert change.recover_schedule_change(setup.store, operation).status == 'needs_recovery'
    assert apply(setup, item, candidate, plan, split='none').status == 'needs_recovery'
    assert setup.book.writes == 1 and setup.projections == 1
    setup.projection_failure = False
    value = setup.ledger.snapshot('brian')['allocations'][0]
    projection.sync_pending(setup.ledger, allocation_ids={value['id']})
    assert change.recover_schedule_change(setup.store, operation).status == 'completed'
    assert setup.book.writes == 1 and len(setup.ledger.snapshot('brian')['allocations']) == 1


def test_bill_with_unavailable_shared_accounting_never_falls_back_to_raw_write(setup, monkeypatch):
    item, candidate = setup.seed('bill')
    monkeypatch.setenv('BOOKIEBOT_REIMBURSEMENTS_ENABLED', 'false')
    with pytest.raises(change.ScheduleChangeConflict, match='Shared bill accounting'):
        preview(setup, item, candidate, split='none')
    assert setup.book.writes == 0


def test_changed_shared_ledger_invalidates_review_before_claim(setup):
    item, candidate = setup.seed('bill')
    value = shared_bill(setup)
    plan = preview(setup, item, candidate)
    setup.ledger.revise_allocation('brian', value['id'], value['version'], dict(
        method='equal', payerShareCents=5000, partnerShareCents=5000, lifecycle='active'), operation='split')
    with pytest.raises(change.ScheduleChangeConflict):
        apply(setup, item, candidate, plan)
    assert not setup.book.writes and setup.store.get_import_operation('brian', item.id) is None
