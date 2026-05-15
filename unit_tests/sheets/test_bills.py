from datetime import date

from bookiebot.sheets.bills import (
    BILL_SCHEDULE_HEADERS,
    BillSchedule,
    due_bill_reminders_for_bills,
    list_bill_schedules,
    next_bill_pull_date,
    overdue_bill_pull_date,
    parse_bill_schedules_with_warnings,
    due_bill_reminders,
)
from unit_tests.support.sheets_repo_stub import SheetsRepoStub


def test_hidden_bill_schedule_templates_are_seeded_without_reminders_or_warnings():
    repo = SheetsRepoStub(income_rows=[["Rent", ""]])

    with repo.patched():
        reminders, warnings = due_bill_reminders(date(2026, 5, 15))

    rows = repo.bill_schedule.get_all_values()
    assert reminders == []
    assert warnings == []
    assert rows[0] == BILL_SCHEDULE_HEADERS
    assert rows[1][0:6] == ["rent", "Rent", "monthly", "", "", "Rent"]


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
        "_BookieBot Bill Schedule!A2:I2: invalid recurrence (PG&E, weekly)",
        "_BookieBot Bill Schedule!A3:I3: quarterly bill missing pull months (Recology)",
        "_BookieBot Bill Schedule!A4:I4: missing or invalid pull day (Water, bad)",
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
