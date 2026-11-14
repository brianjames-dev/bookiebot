from dataclasses import replace
from datetime import date, datetime
from types import SimpleNamespace
import pytest

from bookiebot.reports import expense_breakdown as report, transactions
from bookiebot.sheets import undo
from bookiebot.sheets.recurring import BILL_TAB, SUBSCRIPTION_TAB
from bookiebot.sheets.recurring_rows import encode, runtime_tables, legacy_plans
from bookiebot.sheets.recurring_charges import BillCharge, encode_charges, source_anchor
from unit_tests.sheets.test_recurring import plan
from unit_tests.sheets.test_recurring_storage import fixture, B, TODAY
from bookiebot.sheets import recurring_storage as storage


def test_quarterly_subscription_reaches_reports_transactions_and_reminders_once(monkeypatch):
    monkeypatch.setattr('bookiebot.reports.phone_history.now_pacific', lambda: datetime(2027,3,1))
    from bookiebot.sheets.recurring import normalize_plan
    from bookiebot.sheets.subscriptions import list_subscription_schedules, next_pull_date
    from unit_tests.sheets.test_recurring import form
    p = normalize_plan(form(type='subscription', name='Quarterly service', cadence='quarterly', pullMonths=[2,5,8,11],
        category='subscriptions_wants', splitMethod='none'), current=None, today=TODAY, plan_id='quarter_sub_123')
    p = replace(p, version='quarter-v1')
    rows = encode([p], SUBSCRIPTION_TAB, [])
    assert next_pull_date(list_subscription_schedules(rows, period='2026-11')[0], TODAY) == date(2026,11,30)
    for period, as_of, expected in [('2026-11', date(2026,11,30), '2026-11-30'),
                                    ('2026-12', date(2026,12,31), None), ('2027-02', date(2027,2,28), '2027-02-28')]:
        _, virtual, _ = runtime_tables('brian', [], rows, [])
        items = transactions._subscription_rows(B, period, virtual, as_of=as_of)
        assert [item['date'] for item in items] == ([expected] if expected else [])
        assert sum(item['amountCents'] for item in items) == (6023 if expected else 0)
        year, month = map(int, period.split('-'))
        overview = report._current_month_subscription_items(report._subscription_items(virtual), report.BudgetMonth(year, month))
        assert len(overview) == (1 if expected else 0)
        assert round(sum(item.amount for item in overview), 2) == (60.23 if expected else 0)


@pytest.mark.parametrize('kind', ['fixed', 'variable'])
def test_wants_bill_reads_only_its_d_column(kind):
    p = replace(plan(), id='wants_bill_123', kind=kind, category='subscriptions_wants', monthly_source=True, version='v1')
    runtime, _, _ = runtime_tables('brian', encode([p], BILL_TAB, []), [], [])
    items = report._payment_items([['',p.source_label,'999','60.23']], runtime, report.BudgetMonth(2026,11), as_of=date(2026,11,30))
    assert len(items) == 1 and items[0].amount == 60.23 and items[0].group == 'subscriptions_wants'


def sub(**changes):
    baseline = replace(plan(), id="subscription_123", kind="subscription", name="Xfinity", source_label="Xfinity", source_tab=SUBSCRIPTION_TAB,
                   version="v1", amount_cents=1000, pull_day=2, monthly_source=False)
    return replace(baseline, **changes)


def totals(bills, subscriptions, period, personal):
    year, month = map(int, period.split("-"))
    selected = report.BudgetMonth(year, month)
    payments = report._payment_items(personal, bills, selected, as_of=date(year, month, 28))
    subs = report._current_month_subscription_items(report._subscription_items(subscriptions), selected)
    return round(sum(p.amount for p in payments) + sum(s.amount for s in subs), 2)


def test_future_price_and_monthly_source_migration_count_once_in_each_month(monkeypatch):
    monkeypatch.setattr("bookiebot.reports.phone_history.now_pacific", lambda: datetime(2026, 12, 28, 12))
    old = sub(effective_until="2026-12")
    new = replace(old, effective_from="2026-12", effective_until="9999-12", monthly_source=True, amount_cents=2000, version="v2")
    bills, subscriptions, _ = runtime_tables("brian", [], encode([old, new], SUBSCRIPTION_TAB, []), [])
    assert totals(bills, subscriptions, "2026-11", [["", "Xfinity", ""]]) == 10
    assert totals(bills, subscriptions, "2026-12", [["", "Xfinity", "20"]]) == 20
    assert not transactions._subscription_rows(B, "2026-12", subscriptions, as_of=date(2026, 12, 28))


def test_adopted_months_have_gaps_and_never_overlap_or_duplicate_virtual_charges():
    p = sub()
    charges = [BillCharge(p.id, f"2026-{month:02d}", f"2026-{month:02d}-02", p.source_label, p.category,
        1, 5, 3, source_anchor(p.id, f"2026-{month:02d}"), 1000, True) for month in (8, 11)]
    bills, subscriptions, _ = runtime_tables("brian", [], encode([p], SUBSCRIPTION_TAB, []), [], encode_charges(charges, []))
    for month in range(7, 13):
        assert totals(bills, subscriptions, f"2026-{month:02d}", [["", "Xfinity", "10" if month in (8, 11) else ""]]) == 10


def test_managed_empty_subscriptions_do_not_resurrect_visible_sheet_subtotals():
    month = report.BudgetMonth(2026, 11)
    assert report._subscription_breakdown_totals([["Static Bills & Subscriptions (Needs)", "100"]], [], [], month, managed=True) == (0, 0)


def test_variable_entry_keeps_saved_autopay_date_and_wants_sources_use_d_column():
    p = replace(plan(), id="variable_123", kind="variable", name="Water", source_label="Water", amount_cents=None,
                pull_day=22, monthly_source=True, version="v1")
    c = BillCharge(p.id, "2026-11", "2026-11-13", p.name, p.category, 1, 1, 3, source_anchor(p.id, "2026-11"), 6301, True)
    bills, _, _ = runtime_tables("brian", encode([p], BILL_TAB, []), [], [], encode_charges([c], []))
    payments = report._payment_items([["", "Water", "63.01"]], bills, report.BudgetMonth(2026, 11), as_of=TODAY)
    assert [(p.amount, p.date, p.status) for p in payments] == [(63.01, "2026-11-22", "queued")]
    elapsed = report._payment_items([["", "Water", "63.01"]], bills, report.BudgetMonth(2026, 11), as_of=date(2026, 11, 22))
    assert [(p.amount, p.date, p.status) for p in elapsed] == [(63.01, "2026-11-22", "paid")]
    wanted = sub(monthly_source=True, category="subscriptions_wants")
    bills, _, _ = runtime_tables("brian", [], encode([wanted], SUBSCRIPTION_TAB, []), [])
    rows = [["", "Xfinity", "999", "10"]]
    assert totals(bills, [], "2026-11", rows) == 10
    logged = next(transactions._manual_actions(B, "2026-11", [], rows, bills))
    assert logged.action.columns == [4] and logged.action.new_values == ["10"]
    assert undo._fixed_budget_target_matches(SimpleNamespace(get_all_values=lambda: rows), logged.action)
    assert not undo._fixed_budget_target_matches(SimpleNamespace(get_all_values=lambda: [["", "Other", "", "10"]]), logged.action)


def test_fully_repaid_charge_still_preserves_its_month_and_rejects_another_amount(monkeypatch):
    client, p = fixture([replace(plan(), id="loan_1234", kind="variable", amount_cents=None, pull_day=12, monthly_source=True, version="v1")])
    client.http_client.rows["November"][0][2] = "0"
    client.http_client.formulas["November"][0][2] = "0"
    monkeypatch.setattr("bookiebot.reimbursements.service.enabled", lambda: True)
    ledger = {"id": "allocation-1", "version": 3, "payerOwner": "brian", "sourceYear": 2026, "sourceWorksheet": "income",
              "sourceSheetTitle": "November", "billPlanId": p.id, "sourceValues": {"item": p.source_label}, "settledCents": 6023}
    monkeypatch.setattr("bookiebot.reimbursements.service.build_reimbursement_store", lambda: SimpleNamespace(snapshot=lambda *a, **kw: {"allocations": [ledger]}))
    source = storage.read_workbook(B, TODAY, client=client)
    info = source.charge(p, "2026-11")
    assert info["recorded"] and source.settings.earliest_months[p.id] == "2026-12"
    from bookiebot.reports.bill_settings import _amount_review
    with pytest.raises(ValueError, match="already recorded"):
        _amount_review(source, {"operation": "amount", "id": p.id, "month": "2026-11", "amount": "60.23",
            "settingsVersion": source.settings.version, "chargeVersion": info["version"]}, TODAY)


def test_importing_legacy_bills_never_invents_a_saved_recurring_split():
    rows = [["bill_key", "display_name", "recurrence", "pull_day", "pull_months", "source_label"], ["rent", "Rent", "monthly", "1", "", "Rent"]]
    assert legacy_plans("brian", rows, [])[0].split_method == "none"


def test_legacy_lowercase_split_keeps_zero_cash_recorded_and_its_autopay_date(monkeypatch):
    p = replace(plan(), id="pge_1234", kind="variable", name="PG&E", source_label="PG&E",
                amount_cents=None, pull_day=22, monthly_source=True, version="v1")
    client, _ = fixture([p])
    client.http_client.rows["November"][0][2] = "0"
    client.http_client.formulas["November"][0][2] = "0"
    value = {"id": "allocation-1", "version": 3, "payerOwner": "brian", "partnerOwner": "hannah",
             "sourceYear": 2026, "sourceWorksheet": "income", "sourceSheetTitle": "November",
             "sourceValues": {"item": "pg&e"}, "expenseDate": "2026-11-01", "category": "pg&e",
             "partnerShareCents": 6023, "settledCents": 6023, "lifecycle": "active"}
    event = {"allocationId": value["id"], "status": "confirmed", "date": "2026-11-02", "amountCents": 6023}
    monkeypatch.setattr("bookiebot.reimbursements.service.enabled", lambda: True)
    monkeypatch.setattr("bookiebot.reimbursements.service.build_reimbursement_store",
        lambda: SimpleNamespace(snapshot=lambda *a, **kw: {"allocations": [value], "events": [event]}))
    source = storage.read_workbook(B, TODAY, client=client)
    assert source.charge(p, "2026-11")["recorded"]
    assert source.charge(p, "2026-11")["date"] == "2026-11-22"
    assert source.charge(p, "2026-11")["status"] == "confirmed"
    assert source.settings.earliest_months[p.id] == "2026-12"
    runtime, _, _ = runtime_tables("brian", source.rows[BILL_TAB], [], [])
    from bookiebot.sheets.recurring_rows import with_recorded_months
    runtime = with_recorded_months(runtime, [], [value], owner="brian", year=2026)
    assert "2026-11" in runtime[1][runtime[0].index("recorded_months")]
    assert not client.http_client.sent


def test_zero_confirmed_cash_does_not_resurrect_an_estimated_bill(monkeypatch):
    from datetime import datetime
    from bookiebot.sheets.routing import PACIFIC_TZ
    from unit_tests.support.sheets_repo_stub import InMemoryWorksheet
    monkeypatch.setenv("BOOKIEBOT_REIMBURSEMENTS_ENABLED", "false")
    monkeypatch.setattr(report, "now_pacific", lambda: datetime(2026, 11, 13, 12, tzinfo=PACIFIC_TZ))
    p = replace(plan(), id="fully_repaid_123", pull_day=12, version="v1", monthly_source=True)
    charge = BillCharge(p.id, "2026-11", "2026-11-12", p.source_label, p.category, 1, 2, 3,
        source_anchor(p.id, "2026-11"), 6023, True)
    result = report.build_expense_breakdown_report(actor_key=B, owner_name="Brian", persons=["Brian"], month=report.BudgetMonth(2026, 11),
        worksheets=report.ReportWorksheets(shared_expenses=InMemoryWorksheet([]), personal_budget=InMemoryWorksheet([["Monthly Income", "1000"], ["", p.source_label, "0"]]),
            bill_schedule=InMemoryWorksheet(encode([p], BILL_TAB, [])), bill_charges=InMemoryWorksheet(encode_charges([charge], []))))
    payload = report.expense_breakdown_client_payload(result)
    assert payload["modeViews"]["current"]["metrics"]["totalExpenses"] == 0
    assert payload["modeViews"]["projected"]["metrics"]["totalExpenses"] == 0


def test_recorded_zero_from_canonical_ledger_cannot_create_a_forecast_again():
    from bookiebot.sheets.recurring_rows import with_recorded_months
    p = replace(plan(), id="fully_repaid_123", pull_day=12, version="v1", monthly_source=True)
    allocations = [{"payerOwner": "brian", "sourceYear": 2026, "sourceWorksheet": "income", "billPlanId": p.id,
        "expenseDate": "2026-11-12", "sourceValues": {"item": p.source_label}}]
    rows = with_recorded_months(encode([p], BILL_TAB, []), [], allocations, owner="brian", year=2026)
    paid = report._payment_items([["", p.source_label, "0"]], rows, report.BudgetMonth(2026, 11), as_of=TODAY)
    assert len(paid) == 1 and paid[0].amount == 0 and paid[0].status == "paid"


def test_future_native_reminder_uses_the_effective_price_and_no_duplicate_subscription(monkeypatch):
    from bookiebot.sheets.subscriptions import list_subscription_schedules, next_pull_date, due_subscription_reminders_for_subscriptions
    before = sub(effective_until="2026-12")
    after = replace(before, effective_from="2026-12", effective_until="9999-12", amount_cents=2000, version="v2")
    source = list_subscription_schedules(encode([before, after], SUBSCRIPTION_TAB, []), all_versions=True)
    assert next_pull_date(source[0], date(2026, 11, 29)) is None
    assert next_pull_date(source[1], date(2026, 11, 29)) == date(2026, 12, 2)
    assert [r.subscription.amount for r in due_subscription_reminders_for_subscriptions(source, date(2026, 11, 29))] == [20]
    physical = replace(after, monthly_source=True)
    assert not due_subscription_reminders_for_subscriptions(list_subscription_schedules(encode([physical], SUBSCRIPTION_TAB, []), all_versions=True), date(2026, 11, 29))
