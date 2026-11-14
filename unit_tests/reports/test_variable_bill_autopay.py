from copy import deepcopy
from datetime import datetime, date

import pytest

from bookiebot.reports import transactions as tx
from bookiebot.sheets.bills import BILL_SCHEDULE_HEADERS
from bookiebot.sheets.routing import PACIFIC_TZ
from unit_tests.reports.test_reimbursed_bill_transactions import bill as bill, B
from unit_tests.reimbursements.test_store import access as access, payment


@pytest.mark.parametrize('native', [False, True])
def test_invoice_and_early_reimbursement_stay_scheduled_until_saved_autopay(bill, monkeypatch, native):
    read = tx.read_workbook_tabs
    def workbook(*args):
        tables = deepcopy(read(*args))
        if 'November' in tables and '_BookieBot Bill Schedule' in tables:
            tables['_BookieBot Bill Schedule'][1][3] = '22'
        return tables
    monkeypatch.setattr(tx, 'read_workbook_tabs', workbook)
    if native:
        import json
        body = json.loads(bill.history[1][5])
        body['metadata']['bill_charge_date'] = '2026-11-01'
        bill.history[1][5] = json.dumps(body)
    bill.store.command(bill.owner, payment(bill.allocation, 7208))
    before = deepcopy([bill.personal, bill.history, bill.store.snapshot(bill.owner)])
    assert tx.listing(B, {'month':'2026-11', 'view':'daily', 'fresh':'1'})['items'] == []
    scheduled = tx.load_transactions(B, '2026-11', fresh=True, include_scheduled=True)
    assert scheduled[0]['date'] == '2026-11-22'
    assert scheduled[0]['displayAmountCents'] == 8000
    assert tx.load_transactions(B, '2026-11') == []  # Internal inspection cannot contaminate the public cache.
    bill.clock[0] = datetime(2026, 11, 22, tzinfo=PACIFIC_TZ)
    result = tx.listing(B, {'month':'2026-11', 'view':'daily', 'fresh':'1'})
    assert len(result['items']) == 1
    assert result['items'][0]['id'] == scheduled[0]['id']
    assert result['items'][0]['date'] == '2026-11-22'
    assert result['totalAmountCents'] == 8000
    assert [bill.personal, bill.history, bill.store.snapshot(bill.owner)] == before


def test_known_amount_is_projected_until_autopay_not_invoice_or_repayment_date():
    from bookiebot.reports.expense_breakdown import _payment_items, BudgetMonth
    from bookiebot.sheets.bill_payment_evidence import settled_bill_dates
    from unit_tests.sheets.test_bill_payment_evidence import evidence, event
    schedule = [BILL_SCHEDULE_HEADERS, ['pge','PG&E','monthly','22','','PG&E','','','','']]
    dates = settled_bill_dates([evidence()], [event()], owner='brian', as_of=date(2026,11,14))
    assert not dates
    for day, status in ((14,'queued'), (22,'paid')):
        items = _payment_items([['','PG&E','98.44']], schedule, BudgetMonth(2026,11), as_of=date(2026,11,day), recorded_dates=dates)
        assert len(items) == 1 and items[0].status == status
        assert items[0].date == '2026-11-22' and items[0].amount == 98.44
