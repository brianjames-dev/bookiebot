"""Owed/Due presentation uses confirmed cash without a second expense."""
from copy import deepcopy

import pytest

from bookiebot.reimbursements import service, store as stores
from bookiebot.reports import transactions as tx
from bookiebot.reports.transaction_repayments import repayment_details
from bookiebot.sheets import undo
from unit_tests.reports.test_transactions import saved, access, B, H  # noqa: F401
from unit_tests.reimbursements.test_store import payload, payment, command, reset_command


@pytest.fixture
def purchase(saved, monkeypatch):
    ledger = stores.ReimbursementStore(saved.access)
    ledger.initialize()
    with saved.repos[saved.month].patched():
        columns = undo._category_columns('shopping')
    allocation = ledger.register_allocation(payload(
        sourceActionId=saved.ids[saved.month, 3], splitActionId='split-fixture',
        sourceWorksheet='expense', sourceSheetTitle=tx.calendar.month_name[int(saved.month[-2:])],
        sourceRow=3, sourceYear=int(saved.month[:4]), expenseDate=saved.month+'-01',
        category='shopping', item='Fixture cable 3', location='Fixture store',
        sourceColumnMap=columns, sourceValues={'date':saved.month+'-20','item':'Fixture cable 3',
            'amount':'3.00','location':'Fixture store','person':'Brian (BofA)'},
        grossCents=300, payerShareCents=100, partnerShareCents=200, method='custom',
        customPayerBasisPoints=3333))
    ledger.mark_projected(allocation['id'], allocation['version'])
    monkeypatch.setenv('BOOKIEBOT_REIMBURSEMENTS_ENABLED','true')
    monkeypatch.setattr(service,'build_reimbursement_store',lambda:ledger)
    monkeypatch.setattr(stores,'build_reimbursement_store',lambda:ledger)
    return saved, ledger, ledger.get_allocation(allocation['id'])


def listing(purchase, actor=B):
    saved, ledger, allocation = purchase
    return tx.listing(actor, {'month':saved.month,'view':'daily','scope':'spending','fresh':'1'})


def managed(result):
    return next(row for row in result['items'] if row.get('repayment'))


def test_payer_cash_and_debtor_zero_paid_context_are_read_only(purchase):
    saved, ledger, allocation = purchase
    before = deepcopy([saved.repos[saved.month].expense._rows, ledger.snapshot('brian')])
    payer = managed(listing(purchase))
    debtor_result = listing(purchase,H)
    debtor = managed(debtor_result)
    assert payer['amountCents'] == payer['displayAmountCents'] == 300
    assert payer['repayment']['outstandingCents'] == 200 and payer['repayment']['canEdit']
    assert payer['repayment']['direction'] == 'incoming'
    assert debtor['displayAmountCents'] == 0 and debtor['contextOnly']
    assert debtor['repayment']['direction'] == 'outgoing'
    assert not any(debtor['capabilities'].values())
    assert debtor_result['totalAmountCents'] == 500  # Hannah's actual unrelated purchase only.
    assert [saved.repos[saved.month].expense._rows, ledger.snapshot('brian')] == before
    assert not any('Spreadsheet' in str(row) or '_logged' in row for row in (payer,debtor))


def test_partial_pending_confirmation_reversal_and_no_double_count(purchase):
    saved, ledger, allocation = purchase
    initial = managed(listing(purchase))
    reported = ledger.command('hannah',payment(allocation,50,'report_payment'))
    pending = managed(listing(purchase))
    assert pending['version'] != initial['version']
    assert pending['displayAmountCents'] == 300 and pending['repayment']['pendingCents'] == 50
    assert not pending['capabilities']['split']
    ledger.command('brian',command('confirm_payment', allocationId=allocation['id'],
        version=allocation['version'],eventId=reported['events'][0]['id']))
    payer = managed(listing(purchase))
    debtor_result = listing(purchase,H)
    debtor = managed(debtor_result)
    assert payer['displayAmountCents'] == 250 and payer['amountCents'] == 300
    assert debtor['displayAmountCents'] == 50
    assert debtor_result['totalAmountCents'] == 500  # Context is not another cash entry.
    assert debtor['repayment']['outstandingCents'] == 150
    assert not payer['repayment']['canEdit']
    ledger.command('brian',command('reverse',eventId=reported['events'][0]['id']))
    assert managed(listing(purchase))['displayAmountCents'] == 300
    assert managed(listing(purchase,H))['displayAmountCents'] == 0


def test_context_and_actual_dated_repayment_count_cash_once(purchase):
    saved,ledger,allocation = purchase
    ledger.command('brian',payment(allocation,50))
    repo = saved.repos[saved.month]
    with repo.patched():
        columns = undo._category_columns('shopping')
        fields = {'date':saved.month+'-12','item':'Reimbursement · Fixture cable 3',
                  'amount':'0.50','location':'Reimbursement to Brian','person':'Hannah'}
        for field,column in columns.items():
            repo.expense.update_cell(6,column,fields[field])
    before = deepcopy(repo.expense._rows)
    result = listing(purchase,H)
    assert result['totalAmountCents'] == 550
    context = managed(result)
    assert context['displayAmountCents'] == 50 and context['contextOnly']
    actual = next(row for row in result['items'] if row['title'].startswith('Reimbursement ·'))
    assert actual['amountCents'] == 50 and not any(actual['capabilities'].values())
    assert next(day for day in result['days'] if day['date'].endswith('-12'))['totalCents'] == 50
    assert next(day for day in result['days'] if day['date'].endswith('-01'))['totalCents'] == 0
    assert repo.expense._rows == before


@pytest.mark.parametrize('owner',['brian','hannah'])
def test_named_direction_and_legacy_clear_authority_are_explicit(owner):
    value = {**payload(), 'version':1,'projectedVersion':1,'outstandingCents':4000}
    details = repayment_details(value,[],owner)
    assert details['direction'] == ('incoming' if owner=='brian' else 'outgoing')
    assert details['canEdit'] == (owner=='brian')
    assert not repayment_details({**value,'accounting':'legacy_net'},[],'brian')['canEdit']
    assert not repayment_details({**value,'clearedCents':4000,'outstandingCents':0},[],'brian')['canEdit']


def test_mixed_canonical_snapshots_fail_closed(purchase,monkeypatch):
    saved,ledger,allocation = purchase
    native = undo.canonical_logged_actions
    def raced(*args,**kwargs):
        ledger.revise_allocation('brian',allocation['id'],allocation['version'],
            {'payerShareCents':150,'partnerShareCents':150,'method':'equal'},operation='split')
        return native(*args,**kwargs)
    monkeypatch.setattr(undo,'canonical_logged_actions',raced)
    with pytest.raises(tx.TransactionConflict,match='changed while reading'):
        listing(purchase)


def test_fronted_full_receipt_keeps_zero_payer_row_and_removes_due_context(purchase):
    saved,ledger,allocation = purchase
    value = ledger.revise_allocation('brian',allocation['id'],allocation['version'],
        {'payerShareCents':0,'partnerShareCents':300,'method':'fronted'},operation='split')
    ledger.mark_projected(value['id'],value['version'])
    assert managed(listing(purchase,H))['repayment']['outstandingCents'] == 300
    ledger.command('brian',payment(value,300))
    assert managed(listing(purchase))['displayAmountCents'] == 0
    assert not any(row.get('repayment') for row in listing(purchase,H)['items'])


def test_projection_guard_and_stale_review_fail_closed(purchase):
    saved,ledger,allocation = purchase
    old = managed(listing(purchase))
    ledger.revise_allocation('brian',allocation['id'],allocation['version'],
        {'payerShareCents':150,'partnerShareCents':150,'method':'equal'},operation='split')
    current = managed(listing(purchase))
    assert not current['repayment']['canEdit'] and 'syncing' in current['repayment']['editReason']
    with pytest.raises(tx.TransactionConflict):
        tx.review(B,{'id':old['id'],'month':old['month'],'version':old['version'],'operation':'split','method':'equal'})


def test_context_filtering_and_ledger_failure_do_not_hide_debt(purchase,monkeypatch):
    saved,ledger,allocation = purchase
    query = {'month':saved.month,'view':'daily','search':'Fixture cable 3','split':'shared','fresh':'1'}
    result = tx.listing(H,query)
    assert result['total'] == 1 and result['totalAmountCents'] == 0
    assert result['days'][0]['count'] == 1 and result['days'][0]['totalCents'] == 0
    monkeypatch.setattr(ledger,'snapshot',lambda *a,**k:(_ for _ in ()).throw(RuntimeError('ledger unavailable')))
    with pytest.raises(RuntimeError,match='ledger unavailable'):
        listing(purchase,H)


def test_cancelled_split_has_no_pill_and_can_be_split_again(purchase):
    saved,ledger,allocation = purchase
    value = ledger.revise_allocation('brian',allocation['id'],allocation['version'],
        {'lifecycle':'void'},operation='cancel')
    ledger.mark_projected(value['id'],value['version'])
    row = next(row for row in listing(purchase)['items'] if row['actionId']==allocation['sourceActionId'])
    assert 'repayment' not in row and row['split'] == '' and row['capabilities']['split']
    assert row['splitOptions']['payerCents'] == row['splitOptions']['incomePayerCents']
    assert not any(row.get('repayment') for row in listing(purchase,H)['items'])
