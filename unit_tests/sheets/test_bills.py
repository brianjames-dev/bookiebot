from datetime import date

import pytest

from bookiebot.sheets.bills import (
    BILL_SCHEDULE_HEADERS,
    BillSchedule,
    due_bill_reminders_for_bills,
    list_bill_schedules,
    next_bill_pull_date,
    overdue_bill_pull_date,
    parse_bill_schedules_with_warnings,
    due_bill_reminders,
    bill_amount_for_source_label,
    bill_source_amount,
)
from unit_tests.support.sheets_repo_stub import InMemoryWorksheet, SheetsRepoStub


def test_hidden_bill_schedule_templates_are_seeded_without_reminders_or_warnings():
    repo = SheetsRepoStub(income_rows=[["Rent", ""]])

    with repo.patched():
        reminders, warnings = due_bill_reminders(date(2026, 5, 15))

    rows = repo.bill_schedule.get_all_values()
    assert reminders == []
    assert warnings == []
    assert rows[0] == BILL_SCHEDULE_HEADERS
    assert rows[0][-1] == "expected_amount"
    assert all(len(row) == 10 and row[-1] == "" for row in rows[1:])
    assert rows[1][0:6] == ["rent", "Rent", "monthly", "", "", "Rent"]
    assert all(row[0] != "student_loan" for row in rows[1:])


@pytest.mark.parametrize("populated", [False, True])
def test_only_empty_legacy_nine_column_schedule_is_resized_before_seeding(populated):
    class NarrowWorksheet(InMemoryWorksheet):
        col_count = 9

        def __init__(self, rows):
            super().__init__(rows)
            self.resizes = []

        def resize(self, *, cols):
            self.col_count = cols
            self.resizes.append(cols)

        def update(self, values, range_name=None, **kwargs):
            assert max(len(row) for row in values) <= self.col_count
            return super().update(values, range_name=range_name, **kwargs)

    initial = [BILL_SCHEDULE_HEADERS[:9], ["rent", "Rent", "monthly", "", "", "Rent", "", "", ""]] if populated else []
    repo = SheetsRepoStub(income_rows=[])
    ws = NarrowWorksheet(initial)
    repo.bill_schedule = ws
    with repo.patched():
        assert due_bill_reminders(date(2026, 9, 9)) == ([], [])
    assert ws.resizes == ([] if populated else [10])
    if populated:
        assert ws.get_all_values() == initial
        assert ws.update_calls == 0
    else:
        assert ws.get_all_values()[0] == BILL_SCHEDULE_HEADERS


def test_parse_bill_schedules_supports_monthly_and_quarterly_rows():
    rows = [
        BILL_SCHEDULE_HEADERS,
        ["pge", "PG&E", "monthly", "16", "", "PG&E", "BofA", "", ""],
        ["recology", "Recology", "quarterly", "20", "2,5,8,11", "Recology", "", "", ""],
    ]

    bills = list_bill_schedules(rows)

    assert [(bill.bill_key, bill.recurrence, bill.pull_day, bill.pull_months) for bill in bills] == [
        ("pge", "monthly", 16, ()),
        ("recology", "quarterly", 20, (2, 5, 8, 11)),
    ]


def test_legacy_student_loan_bill_rows_are_ignored():
    rows = [
        BILL_SCHEDULE_HEADERS[:9],
        ["student_loan", "Student Loan Payment", "monthly", "5", "", "Student Loan Payment", "", "", ""],
        ["pge", "PG&E", "monthly", "16", "", "PG&E", "", "", ""],
    ]

    bills, warnings = parse_bill_schedules_with_warnings(rows)

    assert [bill.bill_key for bill in bills] == ["pge"]
    assert bills[0].expected_amount is None
    assert bills[0].source_range == "_BookieBot Bill Schedule!A3:I3"
    assert warnings == []


def test_parse_bill_schedules_reports_invalid_rows():
    rows = [
        BILL_SCHEDULE_HEADERS,
        ["pge", "PG&E", "weekly", "16", "", "PG&E", "", "", ""],
        ["recology", "Recology", "quarterly", "20", "", "Recology", "", "", ""],
        ["water", "Water", "monthly", "bad", "", "Water", "", "", ""],
    ]

    bills, warnings = parse_bill_schedules_with_warnings(rows)

    assert bills == []
    assert [warning.format() for warning in warnings] == [
        "_BookieBot Bill Schedule!A2:J2: invalid recurrence (PG&E, weekly)",
        "_BookieBot Bill Schedule!A3:J3: quarterly bill missing pull months (Recology)",
        "_BookieBot Bill Schedule!A4:J4: missing or invalid pull day (Water, bad)",
    ]


def test_monthly_bill_pull_date_clamps_and_rolls_forward():
    bill = BillSchedule("rent", "Rent", "monthly", 31, source_label="Rent")

    assert next_bill_pull_date(bill, date(2026, 2, 20)) == date(2026, 2, 28)
    assert next_bill_pull_date(bill, date(2026, 3, 31)) == date(2026, 3, 31)
    assert next_bill_pull_date(bill, date(2026, 4, 1)) == date(2026, 4, 30)


def test_quarterly_bill_only_appears_in_allowed_months():
    bill = BillSchedule("recology", "Recology", "quarterly", 20, (2, 5, 8, 11), "Recology")

    assert next_bill_pull_date(bill, date(2026, 5, 15)) == date(2026, 5, 20)
    assert next_bill_pull_date(bill, date(2026, 6, 1)) == date(2026, 8, 20)
    assert next_bill_pull_date(bill, date(2026, 12, 1)) == date(2027, 2, 20)


def test_due_bill_reminders_include_known_and_missing_amounts():
    repo = SheetsRepoStub(
        income_rows=[
            ["PG&E", "$140.00"],
            ["Water", ""],
        ]
    )
    bills = [
        BillSchedule("pge", "PG&E", "monthly", 16, source_label="PG&E"),
        BillSchedule("water", "Water", "monthly", 18, source_label="Water"),
        BillSchedule("rent", "Rent", "monthly", 25, source_label="Rent"),
    ]

    with repo.patched():
        reminders = due_bill_reminders_for_bills(bills, date(2026, 5, 15))

    assert [(reminder.bill.display_name, reminder.amount, reminder.amount_entered, reminder.days_until) for reminder in reminders] == [
        ("PG&E", 140.0, True, 1),
        ("Water", None, False, 3),
    ]


def test_overdue_missing_bill_repeats_within_current_month_until_amount_entered():
    repo = SheetsRepoStub(income_rows=[["PG&E", ""]])
    bill = BillSchedule("pge", "PG&E", "monthly", 14, source_label="PG&E")

    with repo.patched():
        reminders = due_bill_reminders_for_bills([bill], date(2026, 5, 15))

    assert len(reminders) == 1
    assert reminders[0].overdue is True
    assert reminders[0].pull_date == date(2026, 5, 14)

    paid_repo = SheetsRepoStub(income_rows=[["PG&E", "$140.00"]])
    with paid_repo.patched():
        paid_reminders = due_bill_reminders_for_bills([bill], date(2026, 5, 15))

    assert paid_reminders == []


def test_overdue_bill_does_not_carry_into_next_month():
    bill = BillSchedule("pge", "PG&E", "monthly", 14, source_label="PG&E")

    assert overdue_bill_pull_date(bill, date(2026, 6, 1)) is None


def _loan_rows(amount="59.00", *, day="12"):
    return [
        BILL_SCHEDULE_HEADERS,
        ["student loan", "Student Loan", "monthly", day, "", "Student Loan", "Checking", "Autopay", "", amount],
    ]


def test_explicit_expected_amount_opts_in_new_loan_without_reviving_legacy_rows():
    rows = _loan_rows("$59.00")
    rows.append(["student_loan", "Student Loan Payment", "monthly", "5", "", "Student Loan Payment", "", "", ""])
    bills, warnings = parse_bill_schedules_with_warnings(rows)

    assert warnings == []
    assert len(bills) == 1
    assert bills[0].expected_amount == 59.0
    assert bills[0].source_label == "Student Loan"
    assert bills[0].source_range == "_BookieBot Bill Schedule!A2:J2"
    assert next_bill_pull_date(bills[0], date(2026, 9, 9)) == date(2026, 9, 12)
    assert next_bill_pull_date(bills[0], date(2026, 9, 13)) == date(2026, 10, 12)


@pytest.mark.parametrize("amount", ["NaN", "Infinity", "1e309", "-59", "0", "59.001", "$59/month", "5,9", "1000000000001"])
@pytest.mark.parametrize("loan", [True, False])
def test_invalid_expected_amount_warns_and_skips_instead_of_silently_disabling_it(amount, loan):
    rows = _loan_rows(amount)
    if not loan:
        rows[1][0], rows[1][1], rows[1][5] = "pge", "PG&E", "PG&E"
    bills, warnings = parse_bill_schedules_with_warnings(rows)

    assert bills == []
    assert len(warnings) == 1
    assert warnings[0].reason == "invalid expected amount"


def test_blank_expected_amount_keeps_existing_bill_and_retired_loan_behavior():
    rows = _loan_rows("")
    rows.append(["pge", "PG&E", "monthly", "12", "", "PG&E", "", "", "", ""])
    bills, warnings = parse_bill_schedules_with_warnings(rows)

    assert warnings == []
    assert [bill.bill_key for bill in bills] == ["pge"]
    assert bills[0].expected_amount is None


def test_configured_expected_amount_requires_a_pull_day_instead_of_becoming_a_blank_template():
    bills, warnings = parse_bill_schedules_with_warnings(_loan_rows(day=""))
    assert bills == []
    assert [warning.reason for warning in warnings] == ["missing or invalid pull day"]


@pytest.mark.parametrize("actual, expected, paid", [("0", 59.0, False), ("", 59.0, False), ("$119.92", 119.92, True)])
def test_loan_reminder_uses_expected_amount_only_until_a_payment_is_recorded(actual, expected, paid):
    repo = SheetsRepoStub(income_rows=[["", "Student Loan", actual]])
    bills = list_bill_schedules(_loan_rows())
    with repo.patched():
        reminders = due_bill_reminders_for_bills(bills, date(2026, 9, 9))
    assert len(reminders) == 1
    assert reminders[0].amount == expected
    assert reminders[0].amount_entered is paid
    assert reminders[0].days_until == 3


def test_expected_loan_amount_remains_unpaid_after_month_end_clamping():
    bill = list_bill_schedules(_loan_rows(day="31"))[0]
    repo = SheetsRepoStub(income_rows=[["", "Student Loan", "0"]])
    with repo.patched():
        february = due_bill_reminders_for_bills([bill], date(2026, 2, 28))
        overdue = due_bill_reminders_for_bills([bill], date(2026, 4, 30))
        next_month = due_bill_reminders_for_bills([bill], date(2026, 5, 1))
    assert [(r.pull_date, r.amount, r.amount_entered) for r in february] == [(date(2026, 2, 28), 59.0, False)]
    assert [(r.pull_date, r.amount, r.amount_entered) for r in overdue] == [(date(2026, 4, 30), 59.0, False)]
    assert next_month == []


def test_overdue_expected_loan_is_not_marked_paid_and_actual_payment_stops_overdue_notice():
    bill = list_bill_schedules(_loan_rows())[0]
    repo = SheetsRepoStub(income_rows=[["", "Student Loan", "0"]])
    with repo.patched():
        reminders = due_bill_reminders_for_bills([bill], date(2026, 9, 13))
    assert len(reminders) == 1
    assert reminders[0].overdue is True
    assert reminders[0].amount == 59.0
    assert reminders[0].amount_entered is False
    assert reminders[0].pull_date == date(2026, 9, 12)
    repo = SheetsRepoStub(income_rows=[["", "Student Loan", "$119.92"]])
    with repo.patched():
        assert due_bill_reminders_for_bills([bill], date(2026, 9, 13)) == []


def test_bill_amount_lookup_requires_a_unique_full_label_not_a_prefix_neighbor():
    repo = SheetsRepoStub(income_rows=[
        ["", "Student Loan Payment", "$242.29"],
        ["", "  STUDENT LOAN  ", "$119.92"],
        ["", "Student Loan 2", "$80.00"],
    ])
    with repo.patched():
        assert bill_amount_for_source_label("Student Loan") == (True, 119.92)
        assert bill_amount_for_source_label("Student") == (False, 0.0)
    repo = SheetsRepoStub(income_rows=[["Student Loan", "$119.92"], ["Student Loan", "$59.00"]])
    with repo.patched():
        assert bill_amount_for_source_label("Student Loan") == (False, 0.0)


@pytest.mark.parametrize("value,expected", [("", 0.0), ("$0.00", 0.0), ("$119.92", 119.92), ("NaN", None), ("#REF!", None), ("-1", None)])
def test_bill_source_amount_distinguishes_unrecorded_from_invalid_or_missing(value, expected):
    assert bill_source_amount([["", "Student Loan", value]], "Student Loan") == expected
    assert bill_source_amount([["", "Student Loan 2", value]], "Student Loan") is None
