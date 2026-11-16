"""Managed onboarding, tenancy and reviewed accounting on both SQL backends."""
from concurrent.futures import ThreadPoolExecutor
from datetime import date
import json
import os
import secrets
from uuid import uuid4

import pytest

from bookiebot.reports import accounts, managed_budget as managed
from bookiebot.reports.app_access import AppAccessStore, PostgresAppAccessStore


@pytest.fixture(params=['sqlite', 'postgres'])
def store(request, tmp_path, monkeypatch):
    monkeypatch.setattr(managed, '_today', lambda: date(2026, 11, 15))
    if request.param == 'sqlite':
        access = AppAccessStore(tmp_path / 'managed.sqlite3')
        access.initialize()
        identities = accounts.AccountStore(access)
        identities.initialize()
        result = managed.ManagedBudgetStore(identities)
        result.initialize()
        yield result
        return
    url = os.getenv('BOOKIEBOT_TEST_POSTGRES_URL', '')
    if not url:
        pytest.skip('Set BOOKIEBOT_TEST_POSTGRES_URL for managed budget SQL parity')
    import psycopg
    from psycopg import sql
    from psycopg.conninfo import make_conninfo
    schema = 'bookiebot_managed_' + uuid4().hex
    with psycopg.connect(url, autocommit=True, connect_timeout=5) as admin:
        admin.execute(sql.SQL('CREATE SCHEMA {}').format(sql.Identifier(schema)))
        try:
            access = PostgresAppAccessStore(make_conninfo(url, options=f'-csearch_path={schema}', connect_timeout=5))
            access.initialize()
            identities = accounts.AccountStore(access)
            identities.initialize()
            result = managed.ManagedBudgetStore(identities)
            result.initialize()
            yield result
        finally:
            admin.execute(sql.SQL('DROP SCHEMA {} CASCADE').format(sql.Identifier(schema)))


def user(store, name='Alex', subject=None):
    browser = secrets.token_urlsafe(32)
    flow = store.accounts.start(browser)
    value = store.accounts.consume(flow['state'], browser)
    def reject(*_):
        pytest.fail('A new user must never use a Sheets/Discord financial adapter')
    return store.accounts.complete(value, subject=subject or uuid4().hex, email='same@example.test',
        name=name, session_token='', validate_actor=reject, enroll=True)


def prepare(store, account, **command):
    return store.prepare(account, {'requestId': uuid4().hex, **command})


def run(store, account, **command):
    review = prepare(store, account, **command)
    store.confirm(account, review['reviewId'])
    return review


def setup(store, account, **changes):
    return run(store, account, operation='setup', name=account.name, incomeCents=500000,
        allocation=[6000, 2500, 1500], startMonth='2026-09', householdName='Our home', **changes)


def entry(store, account, **changes):
    values = dict(operation='add', name='Rent', date='2026-11-01', amountCents=8000,
                  kind='expense', category='needs', split=False, goalId='')
    values.update(changes)
    return run(store, account, **values)


def state(store, account):
    return store.state(account, '2026-11')


def pair(store):
    _, payer = user(store)
    setup(store, payer)
    _, partner = user(store, 'Sam')
    token = store.issue_invite(payer)['token']
    setup(store, partner, invite=token)
    return payer, partner


def test_enrollment_isolated_from_same_email_and_existing_owner_sources(store):
    token, alex = user(store, subject='new-alex')
    _, sam = user(store, subject='new-sam')
    assert alex.id != sam.id and alex.owner == 'managed:' + alex.id
    assert store.accounts.from_session(store.access.get_session(token)) == alex
    assert store.bootstrap(alex)['phase'] == 'onboarding'
    browser = secrets.token_urlsafe(32)
    flow = store.accounts.start(browser)
    _, again = store.accounts.complete(store.accounts.consume(flow['state'], browser), subject='new-alex',
        email='new-address@example.test', session_token='', validate_actor=lambda *_: pytest.fail('legacy'), enroll=True)
    assert again.id == alex.id
    legacy_token, legacy_session = store.access.consume_pairing(store.access.issue_pairing('676638528590970917', 'brian'))
    legacy = store.accounts.for_session(legacy_session, 'Brian')
    with pytest.raises(managed.BudgetConflict, match='existing connected workbook'):
        store.bootstrap(legacy)
    assert store.access.get_session(legacy_token).owner_key == 'brian'
    assert not store.accounts.profile(legacy)['google']['connected']


def test_setup_review_is_atomic_idempotent_private_and_recoverable(store):
    _, alex = user(store)
    body = dict(requestId=uuid4().hex, operation='setup', name='Alex', incomeCents=123456,
                allocation=[6000, 2500, 1500], startMonth='2026-11', householdName='Our home')
    review = store.prepare(alex, body)
    assert store.bootstrap(alex)['phase'] == 'onboarding'
    assert store.recover(alex, review['reviewId']) == review
    assert store.prepare(alex, body) == review
    with pytest.raises(managed.BudgetConflict, match='different change'):
        store.prepare(alex, {**body, 'incomeCents': 1})
    receipt = store.confirm(alex, review['reviewId'])
    assert store.confirm(alex, review['reviewId']) == receipt
    assert store.recover(alex, review['reviewId']) == receipt
    assert store.bootstrap(alex)['phase'] == 'ready'
    report = state(store, alex)['report']
    assert report['metrics']['monthlyIncome'] == 0
    assert report['modeViews']['projected']['metrics']['monthlyIncome'] == 1234.56
    assert report['modeViews']['projected']['categoryBudgets']['needs'] == 740.74
    with store.access.connect() as db:
        assert db.execute('SELECT COUNT(*) AS n FROM app_households').fetchone()['n'] == 1
    _, stranger = user(store)
    with pytest.raises(managed.BudgetConflict, match='unavailable'):
        store.confirm(stranger, review['reviewId'])


def test_one_use_invites_revalidate_at_acceptance_and_never_store_tokens(store):
    _, owner = user(store)
    setup(store, owner)
    first = store.issue_invite(owner)['token']
    second = store.issue_invite(owner)['token']
    _, sam = user(store, 'Sam')
    with pytest.raises(managed.BudgetConflict, match='expired or was used'):
        setup(store, sam, invite=first)
    _, stranger = user(store, 'Stranger')
    def join(person):
        return prepare(store, person, operation='setup', name=person.name, incomeCents=0,
                       allocation=[5000,3000,2000], startMonth='2026-11', invite=second)
    sam_review, other_review = join(sam), join(stranger)
    with store.access.connect() as db:
        rows = [dict(r) for r in db.execute('SELECT * FROM app_household_invites').fetchall()]
        reviews = [dict(r) for r in db.execute('SELECT * FROM managed_reviews').fetchall()]
        assert second not in json.dumps(rows + reviews)
    store.confirm(sam, sam_review['reviewId'])
    with pytest.raises(managed.BudgetConflict, match='expired or was used'):
        store.confirm(stranger, other_review['reviewId'])
    assert store.bootstrap(stranger)['phase'] == 'onboarding'
    assert len(state(store, owner)['household']['members']) == 2
    with pytest.raises(managed.BudgetConflict, match='creator'):
        store.issue_invite(sam)


def test_private_income_goals_and_expenses_do_not_leak_to_household(store):
    payer, partner = pair(store)
    entry(store, payer, name='Private deposit', kind='income')
    entry(store, payer, name='Private purchase')
    run(store, payer, operation='goal', name='Private goal', targetCents=500000)
    assert not state(store, partner)['entries']
    assert not state(store, partner)['goals']
    assert state(store, partner)['budget']['incomeCents'] == 500000
    with pytest.raises(managed.BudgetConflict, match='creator'):
        source = state(store, payer)['entries'][0]
        run(store, partner, operation='delete', entryId=source['id'], version=source['version'])


def test_shared_repayment_requires_both_people_counts_once_in_original_month(store):
    payer, partner = pair(store)
    entry(store, payer, split=True)
    source = state(store, payer)['shared'][0]
    assert state(store, partner)['entries'][0]['personalAmountCents'] == 0
    assert source['outstandingCents'] == 4000
    assert state(store, partner)['report']['sharedReimbursements'][0]['outstandingAmount'] == 40
    report = run(store, partner, operation='repay', entryId=source['id'], amountCents=2500)
    assert store.confirm(partner, report['reviewId'])['completed']
    shared = state(store, payer)['shared'][0]
    receipt = shared['repayments'][0]
    assert shared['outstandingCents'] == 4000 and state(store, payer)['entries'][0]['personalAmountCents'] == 8000
    with pytest.raises(managed.BudgetConflict, match='payer'):
        run(store, partner, operation='confirm-repayment', entryId=source['id'], repaymentId=receipt['id'])
    with pytest.raises(managed.BudgetConflict, match='remaining'):
        run(store, partner, operation='repay', entryId=source['id'], amountCents=2500)
    confirmation = run(store, payer, operation='confirm-repayment', entryId=source['id'], repaymentId=receipt['id'])
    store.confirm(payer, confirmation['reviewId'])
    assert state(store, payer)['entries'][0]['personalAmountCents'] == 5500
    assert state(store, partner)['entries'][0]['personalAmountCents'] == 2500
    assert state(store, payer)['shared'][0]['outstandingCents'] == 1500
    assert store.state(payer, '2026-10')['report']['metrics']['totalExpenses'] == 0
    with pytest.raises(managed.BudgetConflict, match='repayment'):
        run(store, payer, operation='delete', entryId=source['id'], version=1)


def test_savings_transfers_edit_delete_update_saved_goal_and_never_spending(store):
    _, alex = user(store)
    setup(store, alex)
    run(store, alex, operation='goal', name='Emergency fund', targetCents=100000)
    goal = state(store, alex)['goals'][0]['id']
    entry(store, alex, name='To savings', kind='transfer', amountCents=10000, goalId=goal)
    snapshot = state(store, alex)
    assert snapshot['report']['metrics']['amountSaved'] == 100
    assert snapshot['report']['metrics']['totalExpenses'] == 0
    assert snapshot['report']['modeViews']['projected']['metrics']['totalExpenses'] == 0
    assert snapshot['goals'][0]['saved_cents'] == 10000
    row = snapshot['entries'][0]
    entry(store, alex, operation='edit', entryId=row['id'], version=row['version'], name='To savings', kind='transfer', amountCents=15000, goalId=goal)
    assert state(store, alex)['goals'][0]['saved_cents'] == 15000
    row = state(store, alex)['entries'][0]
    run(store, alex, operation='delete', entryId=row['id'], version=row['version'])
    assert state(store, alex)['report']['metrics']['amountSaved'] == 0
    assert state(store, alex)['goals'][0]['saved_cents'] == 0


@pytest.mark.parametrize('changes', [dict(amountCents=-1),dict(amountCents=True),dict(amountCents=1.5),dict(date='2026-11-16'),dict(date='2026-08-31'),dict(kind='income',split=True),dict(goalId='other-owner'),dict(split='yes')])
def test_invalid_or_future_activity_cannot_become_actuals(store, changes):
    _, alex = user(store)
    setup(store, alex)
    with pytest.raises(managed.BudgetConflict):
        entry(store, alex, **changes)
    assert not state(store, alex)['entries']


def test_stale_review_expiry_and_revocation_cannot_mutate_budget(store, monkeypatch):
    token, alex = user(store)
    setup(store, alex)
    first = prepare(store, alex, operation='goal', name='One', targetCents=10000)
    run(store, alex, operation='goal', name='Two', targetCents=10000)
    with pytest.raises(managed.BudgetConflict, match='budget changed'):
        store.confirm(alex, first['reviewId'])
    pending = prepare(store, alex, operation='goal', name='Three', targetCents=10000)
    store.access.revoke_session(token)
    with pytest.raises(managed.BudgetConflict, match='session changed'):
        store.confirm(alex, pending['reviewId'], session_token=token)
    now = managed._now()
    monkeypatch.setattr(managed, '_now', lambda: now + 601)
    assert store.recover(alex, pending['reviewId']) == {'expired': True}
    with pytest.raises(managed.BudgetConflict, match='expired'):
        store.confirm(alex, pending['reviewId'])
    assert [g['name'] for g in state(store, alex)['goals']] == ['Two']


def test_concurrent_enrollment_and_confirmation_do_not_duplicate_rows(store):
    with ThreadPoolExecutor(max_workers=4) as pool:
        identities = list(pool.map(lambda _: user(store, subject='same-subject')[1], range(4)))
    assert len({p.id for p in identities}) == 1
    alex = identities[0]
    review = prepare(store, alex, operation='setup', name=alex.name, incomeCents=0,
        allocation=[5000,3000,2000], startMonth='2026-11', householdName='Our home')
    with ThreadPoolExecutor(max_workers=4) as pool:
        assert all(v['completed'] for v in pool.map(lambda _: store.confirm(alex, review['reviewId']), range(4)))
    with store.access.connect() as db:
        assert db.execute('SELECT COUNT(*) AS n FROM app_households').fetchone()['n'] == 1
        assert db.execute('SELECT COUNT(*) AS n FROM app_household_members').fetchone()['n'] == 1


def test_legacy_people_join_one_household_without_migrating_finances_or_sessions(store):
    def legacy(actor, owner, name):
        token, session = store.access.consume_pairing(store.access.issue_pairing(actor, owner))
        return token, store.accounts.for_session(session, name)
    brian_token, brian = legacy('676638528590970917', 'brian', 'Brian')
    hannah_token, hannah = legacy('830984827904851969', 'hannah', 'Hannah')
    before = (store.access.get_session(brian_token), store.access.get_session(hannah_token))
    review = store.household_review(brian, {'requestId':uuid4().hex,'operation':'create','name':'Our household'}, session_token=brian_token)
    assert store.household(brian)['household'] is None
    assert any('existing connected workbook' in item['value'] for item in review['items'])
    store.household_confirm(brian, review['reviewId'], session_token=brian_token)
    invite = store.issue_invite(brian, session_token=brian_token)['token']
    join = store.household_review(hannah, {'requestId':uuid4().hex,'operation':'join','invite':invite}, session_token=hannah_token)
    receipt = store.household_confirm(hannah, join['reviewId'], session_token=hannah_token)
    assert store.household_confirm(hannah, join['reviewId'], session_token=hannah_token) == receipt
    assert store.household_recover(hannah, join['reviewId']) == receipt
    assert [m['name'] for m in store.household(brian)['household']['members']] == ['Brian', 'Hannah']
    assert {m['provider'] for m in store.household(hannah)['household']['members']} == {'sheets'}
    assert before == (store.access.get_session(brian_token), store.access.get_session(hannah_token))
    assert store.accounts.from_session(before[0]) == brian
    assert store.accounts.from_session(before[1]) == hannah
    with store.access.connect() as db:
        for table in ('managed_budgets','managed_entries','managed_repayments'):
            assert db.execute('SELECT COUNT(*) AS n FROM ' + table).fetchone()['n'] == 0
    with pytest.raises(managed.BudgetConflict, match='existing connected workbook'):
        store.state(brian, '2026-11')


def test_mixed_household_membership_cannot_silently_fork_existing_financial_ledger(store):
    legacy_token, legacy_session = store.access.consume_pairing(store.access.issue_pairing('676638528590970917', 'brian'))
    brian = store.accounts.for_session(legacy_session, 'Brian')
    review = store.household_review(brian, {'requestId':uuid4().hex,'operation':'create','name':'Our household'}, session_token=legacy_token)
    store.household_confirm(brian, review['reviewId'], session_token=legacy_token)
    invitation = store.issue_invite(brian)['token']
    _, new_user = user(store)
    setup(store, new_user, invite=invitation)
    assert len(state(store, new_user)['household']['members']) == 2
    with pytest.raises(managed.BudgetConflict, match='separate shared ledger'):
        entry(store, new_user, split=True)
    entry(store, new_user, split=False)
    assert len(state(store, new_user)['entries']) == 1
    assert store.access.get_session(legacy_token).owner_key == 'brian'


def test_budget_changes_keep_previous_months_and_cents_exact(store):
    _, alex = user(store)
    setup(store, alex)
    run(store, alex, operation='budget', name='Alex', incomeCents=900000,
        allocation=[7000,2000,1000], startMonth='2026-09')
    assert store.state(alex, '2026-10')['report']['incomeProjection']['projectedAmount'] == 5000
    assert state(store, alex)['report']['incomeProjection']['projectedAmount'] == 9000
    assert managed._allocate(1, [5000,5000,0]) == {'needs':.01,'wants':0,'savings':0}
    assert round(sum(managed._allocate(123456, [6000,2500,1500]).values())*100) == 123456


def test_dismissed_repayment_frees_share_without_claiming_money_received(store):
    payer, partner = pair(store)
    entry(store, payer, split=True)
    source = state(store, payer)['shared'][0]
    run(store, partner, operation='repay', entryId=source['id'], amountCents=4000)
    receipt = state(store, partner)['shared'][0]['repayments'][0]
    run(store, payer, operation='remove-repayment', entryId=source['id'], repaymentId=receipt['id'])
    assert state(store, partner)['shared'][0]['pendingCents'] == 0
    assert state(store, partner)['entries'][0]['personalAmountCents'] == 0
    assert state(store, payer)['entries'][0]['personalAmountCents'] == 8000
    run(store, partner, operation='repay', entryId=source['id'], amountCents=4000)
    assert state(store, partner)['shared'][0]['pendingCents'] == 4000
