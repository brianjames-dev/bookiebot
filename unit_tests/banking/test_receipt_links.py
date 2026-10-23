"""Saved bank evidence must identify exactly one canonical shared expense."""
from copy import deepcopy
from types import SimpleNamespace

import pytest

from bookiebot.banking import receipt_links as links
from bookiebot.sheets.bills import BILL_SCHEDULE_HEADERS
from bookiebot.sheets.routing import now_pacific


@pytest.fixture
def setup(monkeypatch):
    today = now_pacific().date()
    allocation = dict(id='shared-water', payerOwner='brian', partnerOwner='hannah', accounting='cash_v1',
        sourceActionId='bill-source', sourceWorksheet='income', sourceYear=today.year,
        sourceSheetTitle=today.strftime('%B'), sourceRow=12, sourceColumnMap={'item': 2, 'amount': 3},
        category='water', expenseDate=today.isoformat(), grossCents=12500, outstandingCents=4409)
    item = SimpleNamespace(status='confirmed', matched_action_log_id='bill-source', matched_sheet_ref=None,
        transaction=SimpleNamespace(amount=125, pending=False, date=today.isoformat(), authorized_date=None))
    rows = [allocation]
    monkeypatch.setattr(links.reimbursements, 'enabled', lambda: True)
    monkeypatch.setattr(links.reimbursements, 'snapshot', lambda owner: {'allocations': rows})
    def no_sheet(*args):
        raise AssertionError('An exact action/physical match must not read Sheets')
    monkeypatch.setattr(links, 'get_existing_personal_worksheet', no_sheet)
    return SimpleNamespace(rows=rows, allocation=allocation, item=item)


def test_exact_source_link_is_read_only_and_preserves_gross_after_partial_receipt(setup):
    result = links.matched_receipt_link('brian', 'actor', setup.item)
    assert result == dict(allocationId='shared-water', partner='Hannah', bankAmountCents=12500, outstandingCents=4409)
    setup.allocation['outstandingCents'] = 0
    assert links.matched_receipt_link('brian', 'actor', setup.item)['outstandingCents'] == 0


@pytest.mark.parametrize('state', ['needs_review', 'pending_user', 'ignored', 'import_requested'])
def test_unmatched_or_uncertain_bank_entries_never_offer_receipt(setup, state):
    setup.item.status = state
    assert links.matched_receipt_link('brian', 'actor', setup.item) is None


@pytest.mark.parametrize('change', ['pending', 'inflow', 'other_payer', 'different_gross', 'legacy', 'void', 'unlinked', 'ambiguous', 'wrong_month'])
def test_unverified_shared_payment_cannot_be_selected_by_amount_alone(setup, change):
    if change == 'pending': setup.item.transaction.pending = True
    elif change == 'inflow': setup.item.transaction.amount = -125
    elif change == 'other_payer': setup.allocation['payerOwner'] = 'hannah'
    elif change == 'different_gross': setup.allocation['grossCents'] = 12600
    elif change == 'legacy': setup.allocation['accounting'] = 'legacy_net'
    elif change == 'void': setup.allocation['lifecycle'] = 'void'
    elif change == 'unlinked': setup.item.matched_action_log_id = 'unrelated'
    elif change == 'ambiguous': setup.rows.append({**deepcopy(setup.allocation), 'id': 'another'})
    else: setup.allocation['sourceYear'] -= 1
    assert links.matched_receipt_link('brian', 'actor', setup.item) is None


def test_physical_evidence_links_a_saved_update_ancestor(setup):
    setup.item.matched_action_log_id = 'older-action'
    setup.item.matched_sheet_ref = f'income!row 12#cols=2,3#month={now_pacific():%Y-%m}'
    assert links.matched_receipt_link('brian', 'actor', setup.item)['allocationId'] == 'shared-water'
    setup.item.matched_sheet_ref = setup.item.matched_sheet_ref.replace('#cols=2,3', '#cols=4')
    assert links.matched_receipt_link('brian', 'actor', setup.item) is None


def test_schedule_only_match_requires_exact_source_and_occurrence(setup, monkeypatch):
    month = now_pacific().strftime('%Y-%m')
    setup.item.matched_action_log_id = None
    setup.item.matched_sheet_ref = f'_BookieBot Bill Schedule!A2:J2#pull={month}'
    rows = [BILL_SCHEDULE_HEADERS, ['water', 'Water', 'monthly', '1', '', 'Water', '', '', '', '125']]
    monkeypatch.setattr(links, 'get_existing_personal_worksheet', lambda title: SimpleNamespace(get_all_values=lambda: rows))
    assert links.matched_receipt_link('brian', 'actor', setup.item)['allocationId'] == 'shared-water'
    setup.item.matched_sheet_ref = setup.item.matched_sheet_ref.replace('A2:J2', 'A3:J3')
    assert links.matched_receipt_link('brian', 'actor', setup.item) is None
