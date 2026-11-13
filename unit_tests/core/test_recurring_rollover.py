from dataclasses import replace
from datetime import datetime
from types import SimpleNamespace
from unittest.mock import Mock
import pytest

from bookiebot.core import recurring_bills
from bookiebot.reports import bill_settings as bills
from bookiebot.sheets import recurring_storage as storage
from bookiebot.sheets.recurring import BILL_TAB
from bookiebot.sheets.recurring_rows import encode, decode
from unit_tests.sheets.test_recurring_storage import fixture, Transport, B
from unit_tests.reports.test_bill_settings import saved as saved
from unit_tests.reports.test_goals_store import access as access


@pytest.mark.parametrize('first_failure', [None, 'prewrite', 'rejected'])
def test_backend_carries_authorized_versions_when_external_rollover_script_is_older(saved, monkeypatch, first_failure):
    loan = replace(saved.loan, split_method="none", request_id="confirmed-plan", effective_until="2027-01")
    new_loan = replace(loan, effective_from="2027-01", effective_until="9999-12", amount_cents=8000, version="loan-v2")
    insurance = replace(loan, id="insurance_123", name="Insurance", source_label="Insurance", amount_cents=10000,
        pull_day=31, effective_from="2027-01", effective_until="9999-12", version="insurance-v1")
    previous, _ = fixture([loan, new_loan, insurance])
    rows = {BILL_TAB: [["bill_key", "display_name", "recurrence", "pull_day", "pull_months", "source_label", "expected_amount", "tracking_mode"],
        ["student_loan", "Student Loan", "monthly", "12", "", "Student Loan", "60.23", "automatic"]],
        "Subscriptions": [], "January": [["", "Student Loan", "60.23"], ["", "(Needs) Subtotal:", "=SUM(C1:C1)"]]}
    current = SimpleNamespace(http_client=Transport(rows))
    current.http_client.formulas["January"][0][2] = "=SUMIF('_BookieBot Bill Schedule'!F:F,\"Student Loan\",'_BookieBot Bill Schedule'!G:G)"
    monkeypatch.setattr(storage, "get_budget_spreadsheet_id_for_user", lambda actor, year: f"personal-{year}")
    monkeypatch.setattr(bills, "read_workbook", lambda actor, today: storage.read_workbook(actor, today, client=current if today.year == 2027 else previous))
    monkeypatch.setattr(bills, "now_pacific", lambda: datetime(2027, 1, 17, 12))
    monkeypatch.setattr(recurring_bills, "now_pacific", bills.now_pacific)
    monkeypatch.setattr(bills, "build_commands", lambda: saved.commands)
    monkeypatch.setattr("bookiebot.reimbursements.service.enabled", lambda: False)
    if first_failure:
        writer = current.http_client.batch_update
        if first_failure == 'prewrite':
            reader = bills.read_workbook
            source = reader(B, datetime(2027, 1, 17).date())
            def fail_current(actor, today):
                if today.year == 2027:
                    raise RuntimeError('read failed')
                return reader(actor, today)
            monkeypatch.setattr(bills, 'read_workbook', fail_current)
            assert not bills.carry_year(B, source, saved.commands)
            monkeypatch.setattr(bills, 'read_workbook', reader)
        else:
            from gspread.exceptions import APIError
            response = Mock(status_code=429)
            response.json.return_value = {'error': {'code': 429, 'message': 'quota'}}
            current.http_client.batch_update = Mock(side_effect=APIError(response))
            recurring_bills.process_owner(B)
            current.http_client.batch_update = writer
        assert not current.http_client.sent
    recurring_bills.process_owner(B)
    carried = decode(current.http_client.rows[BILL_TAB], BILL_TAB)
    assert {p.id for p in carried} == {loan.id, insurance.id}
    assert next(p for p in carried if p.id == insurance.id).effective_from == "2027-01"
    assert current.http_client.rows["January"][3][1] == "Insurance"
    assert float(current.http_client.rows["January"][0][2]) == 80
    assert current.http_client.rows["January"][1][2] == "(SUM(C1:C1)+SUM(C4))" or current.http_client.rows["January"][1][2] == "=(SUM(C1:C1)+SUM(C4))"
    calls = len(current.http_client.sent)
    recurring_bills.process_owner(B)
    assert len(current.http_client.sent) == calls
