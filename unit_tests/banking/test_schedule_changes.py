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

ACTOR = '676638528590970917'


class Sheet:
    def __init__(self, title, rows, book):
        self.title, self.rows, self.spreadsheet = title, rows, book
        self.id = title
        self.spreadsheet_id = 'isolated-budget'

    def get_all_values(self, **kwargs):
        return deepcopy(self.rows)


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
    monkeypatch.setattr(change, 'read_active_logged_actions', lambda actor: active)
    monkeypatch.setattr(change, 'read_logged_action_history', lambda actor: history)
    def record(actor, action):
        logged = LoggedAction('new-payment', today.isoformat(), ACTOR, action)
        active.append(logged); history.append(logged)
        return logged.id
    monkeypatch.setattr(change, 'record_undo_action', record)
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
    def seed(kind='subscription', identity='first'):
        amount = 12.99 if kind == 'subscription' else 125
        store.upsert_transactions([dict(transaction_id=identity, date=today.isoformat(),
            name='Cloud' if kind == 'subscription' else 'Water', amount=amount, pending=False)], 'brian')
        tx = next(tx for tx in store.recent_transactions('brian') if tx.provider_transaction_id == identity)
        item = store.upsert_reconciliation_item(owner_key='brian', transaction=tx,
            classification='subscription' if kind == 'subscription' else 'expense', status='needs_review', confidence=0)
        ref = f'Subscriptions!A3:C3#pull={today}' if kind == 'subscription' else f'_BookieBot Bill Schedule!A2:K2#pull={today:%Y-%m}'
        candidate = ActionLogCandidate(f'schedule:{kind}:{ref}', ref, 'schedule', today,
            9.99 if kind == 'subscription' else 100, f'Cloud ({kind})' if kind == 'subscription' else 'Water (bill)', .8, 'Scheduled', True)
        return item, candidate
    setup_data = SimpleNamespace(book=book, store=store, service=SimpleNamespace(store=store), seed=seed,
        active=active, history=history, updates=[])
    return setup_data


def preview(data, item, candidate, future=False):
    return change.prepare_schedule_change('brian', ACTOR, item, candidate, update_future=future)


def apply(data, item, candidate, plan, future=False):
    return change.apply_schedule_change(data.service, 'brian', ACTOR, item, candidate,
        plan['fingerprint'], update_future=future)


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
