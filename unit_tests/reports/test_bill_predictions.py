from copy import deepcopy
from datetime import date
from dataclasses import replace

import pytest

from bookiebot.reports.bill_predictions import predict_bill

TODAY = date(2026, 11, 13)


def test_mean_uses_entered_personal_costs_across_available_years_without_mutation():
    history = [("2025-12", [["", "PG&E", "60.01"]]), ("2026-02", [["", "PG&E", "100.00"]]),
               ("2026-10", [["", "PG&E", "80.00"]]), ("2026-11", [["", "PG&E", "900"]]),
               ("2026-12", [["", "PG&E", "999"]])]
    before = deepcopy(history)
    prediction = predict_bill("PG&E", history, "2026-11", as_of=TODAY)
    assert prediction is not None
    assert prediction.public() == {"amountCents": 8000, "source": "history", "sampleCount": 3,
        "firstMonth": "2025-12", "lastMonth": "2026-10", "basis": "personal_bill_amount"}
    assert predict_bill("PG&E", history, "2027-01", as_of=TODAY) == prediction
    assert history == before


@pytest.mark.parametrize("bad", ["", "0", "0.00", "-5", "#REF!", "NaN", "=C19", "not entered"])
def test_placeholders_errors_and_unrecorded_months_do_not_dilute_the_mean(bad):
    value = predict_bill("Water", [("2026-05", [["Water", "90"]]), ("2026-08", [["Water", bad]])],
                         "2026-11", as_of=TODAY)
    assert value is not None and value.amount_cents == 9000 and len(value.samples) == 1


def test_exact_unique_source_and_period_are_required_and_cents_round_half_up():
    history = [("2026-05", [["", "Water", "10.00"]]), ("2026-08", [["", "WATER", "10.01"]]),
               ("2026-06", [["Water insurance", "900"]]),
               ("2026-07", [["Water", "900"], ["Water", "800"]]),
               ("2026-09", [["Water", "900"]]), ("2026-09", [["Water", "800"]])]
    value = predict_bill("Water", history, "2026-11", as_of=TODAY)
    assert value is not None and value.amount_cents == 1001 and len(value.samples) == 2
    assert predict_bill("New bill", history, "2026-11", as_of=TODAY) is None


def test_historical_target_does_not_train_on_itself_or_later_months():
    history = [("2026-05", [["Water", "60"]]), ("2026-08", [["Water", "90"]])]
    assert predict_bill("Water", history, "2026-05", as_of=TODAY) is None
    value = predict_bill("Water", history, "2026-08", as_of=TODAY)
    assert value is not None and value.amount_cents == 6000


def test_configured_override_is_explicit_and_wants_column_is_isolated():
    history = [("2026-05", [["", "Variable", "999", "25"]])]
    value = predict_bill("Variable", history, "2026-11", as_of=TODAY, amount_column=4)
    assert value is not None and value.amount_cents == 2500
    value = predict_bill("Variable", history, "2026-11", as_of=TODAY, override_cents=12345)
    assert value is not None and value.public() == {"amountCents": 12345, "source": "configured", "sampleCount": 0,
                                                  "basis": "personal_bill_amount"}


def test_fixed_rent_unknown_bills_and_effective_type_changes_keep_their_scope():
    from bookiebot.reports.bill_predictions import scheduled_predictions
    from bookiebot.sheets.bills import BILL_SCHEDULE_HEADERS
    rows = [list(BILL_SCHEDULE_HEADERS), ["rent", "Rent", "monthly", "1", "", "Rent"],
            ["pge", "PG&E", "monthly", "22", "", "PG&E"]]
    assert scheduled_predictions(rows, [("2026-10", [["Rent", "2100"]])], "2026-11", as_of=TODAY) == {}
    rows[0] += ["bill_type", "tracking_mode"]
    rows[1] += ["", "", "", "", "variable", "manual"]
    result = scheduled_predictions(rows, [("2026-10", [["Rent", "2100"]])], "2026-11", as_of=TODAY)
    assert result["rent"].amount_cents == 210000  # Explicit type wins over the legacy default.


def report_with_history(monkeypatch, *, actual="0", month=11, cadence="monthly", pull_months="", name="Electricity", extra=()):
    from bookiebot.reports import expense_breakdown as reports
    from bookiebot.sheets.bills import BILL_SCHEDULE_HEADERS
    from unit_tests.reports.test_expected_bill_reports import _report
    history = (reports.BudgetHistoryRows(reports.BudgetMonth(2025, 12), [["", "PG&E", "60"]]),
               reports.BudgetHistoryRows(reports.BudgetMonth(2026, 8), [["", "PG&E", "100"]]))
    schedule = [BILL_SCHEDULE_HEADERS, ["pge", name, cadence, "22", pull_months, "PG&E"], *extra]
    return _report(monkeypatch, [["", "PG&E", actual]], month=month, schedule=schedule, history=history)


@pytest.mark.parametrize("actual", ["", "0"])
def test_prediction_contributes_only_to_projected_and_future_calendar_context(monkeypatch, actual):
    result, payload = report_with_history(monkeypatch, actual=actual)
    current, projected = payload["modeViews"]["current"], payload["modeViews"]["projected"]
    assert current["metrics"]["totalExpenses"] == 0
    assert not any(e["kind"] == "bill" for e in current["calendarEvents"])
    assert projected["metrics"]["totalExpenses"] == 80
    event = next(e for e in projected["calendarEvents"] if e["kind"] == "bill")
    assert event["amount"] == 80 and event["label"] == "Electricity" and event["day"] == 22
    assert event["projectedOnly"] and event["amountEstimated"] and event["prediction"]["sampleCount"] == 2
    assert not result.payments and not result.queued_bills
    future = next(m for m in payload["calendarContext"] if m["month"] == 12)
    future_bill = next(e for e in future["events"] if e["kind"] == "bill")
    assert future_bill["prediction"] == event["prediction"]
    assert future_bill["amount"] == 80
    assert payload["topEntries"] == payload["dailyEntries"] == []


def test_entered_amount_replaces_prediction_without_changing_current_payment_timing(monkeypatch):
    result, payload = report_with_history(monkeypatch, actual="125.67")
    assert payload["modeViews"]["current"]["metrics"]["totalExpenses"] == 0
    assert payload["modeViews"]["projected"]["metrics"]["totalExpenses"] == 125.67
    event = next(e for e in payload["calendarEvents"] if e["kind"] == "bill")
    assert event["amount"] == 125.67 and "prediction" not in event and "amountEstimated" not in event
    assert len(result.queued_bills) == 1


def test_cadence_closed_months_and_ambiguous_schedules_do_not_manufacture_forecasts(monkeypatch):
    _, closed = report_with_history(monkeypatch, month=8)
    assert closed["modeViews"]["projected"]["metrics"]["totalExpenses"] == 0
    _, off_cycle = report_with_history(monkeypatch, month=10, cadence="quarterly", pull_months="2,5,8,11")
    assert off_cycle["modeViews"]["projected"]["metrics"]["totalExpenses"] == 0
    _, duplicate = report_with_history(monkeypatch, extra=(["other", "Other electricity", "monthly", "22", "", "PG&E"],))
    assert duplicate["modeViews"]["projected"]["metrics"]["totalExpenses"] == 0


def test_wants_forecast_uses_its_own_column_and_retains_the_future_category(monkeypatch):
    from bookiebot.reports import expense_breakdown as reports
    from bookiebot.sheets.recurring import BILL_TAB
    from bookiebot.sheets.recurring_rows import encode
    from unit_tests.sheets.test_recurring import plan
    from unit_tests.reports.test_expected_bill_reports import _report
    from bookiebot.sheets.routing import get_user_config
    owner = get_user_config("676638528590970917")
    monkeypatch.setattr("bookiebot.sheets.routing.get_user_config", lambda *a, **kw: owner)
    monkeypatch.setenv("BOOKIEBOT_REIMBURSEMENTS_ENABLED", "false")
    p = replace(plan(), id="variable_wants", name="Variable", source_label="Variable", kind="variable",
                category="subscriptions_wants", amount_cents=None, monthly_source=True, version="v1")
    _, payload = _report(monkeypatch, [["", "Variable", "999", "0"]], month=11,
        schedule=encode([p], BILL_TAB, []), history=(reports.BudgetHistoryRows(reports.BudgetMonth(2026, 8), [["", "Variable", "999", "25"]]),))
    predicted = next(e for e in payload["calendarEvents"] if e["kind"] == "bill")
    assert predicted["amount"] == 25 and predicted["group"] == "subscriptions_wants"
    future = next(m for m in payload["calendarContext"] if m["month"] == 12)
    assert next(e for e in future["events"] if e["kind"] == "bill")["group"] == "subscriptions_wants"


def test_aliased_duplicate_sources_cannot_bypass_forecast_guard_via_configured_estimates(monkeypatch):
    from bookiebot.sheets.bills import BILL_SCHEDULE_HEADERS
    from unit_tests.reports.test_expected_bill_reports import _report
    schedule = [BILL_SCHEDULE_HEADERS,
        ["one", "Electricity", "monthly", "22", "", "PG&E", "", "", "", "80"],
        ["two", "Other electricity", "monthly", "22", "", "PGE", "", "", "", "90"]]
    _, payload = _report(monkeypatch, [["PG&E", "0"], ["PGE", "0"]], month=11, schedule=schedule)
    assert payload["modeViews"]["projected"]["metrics"]["totalExpenses"] == 0
    assert not any(e.get("amountEstimated") for e in payload["calendarEvents"])
    future = next(m for m in payload["calendarContext"] if m["month"] == 12)
    assert not any(e.get("amountEstimated") for e in future["events"] if e["kind"] == "bill")
    from datetime import datetime
    from bookiebot.reports import bill_settings as bills
    from bookiebot.sheets import recurring_storage as storage
    from unit_tests.sheets.test_recurring import plan
    from unit_tests.sheets.test_recurring_storage import fixture, B
    first = replace(plan(), id="first_utility", kind="variable", name="Electricity", source_label="PG&E",
                    amount_cents=8000, monthly_source=True, split_method="none", version="v1")
    second = replace(first, id="second_utility", name="Other electricity", source_label="PGE", amount_cents=9000)
    client, _ = fixture([first, second])
    client.http_client.rows["November"][0][2] = client.http_client.formulas["November"][0][2] = "0"
    monkeypatch.setenv("BOOKIEBOT_REIMBURSEMENTS_ENABLED", "false")
    monkeypatch.setattr(bills, "now_pacific", lambda: datetime(2026, 11, 13, 12))
    monkeypatch.setattr(bills, "read_workbook", lambda actor, today: storage.read_workbook(actor, today, client=client))
    assert all(b["prediction"] is None for b in bills.listing(B)["bills"])
    assert not client.http_client.sent


@pytest.mark.parametrize("actual", ["-20", "#REF!", "duplicate", "missing", "", "0"])
def test_existing_future_sources_are_not_overridden_by_a_forecast(monkeypatch, actual):
    from bookiebot.reports import expense_breakdown as reports
    from bookiebot.sheets.bills import BILL_SCHEDULE_HEADERS
    from unit_tests.reports.test_expected_bill_reports import _report
    future = ([["", "PG&E", "0"], ["", "PG&E", "0"]] if actual == "duplicate"
              else [] if actual == "missing" else [["", "PG&E", actual]])
    history = (reports.BudgetHistoryRows(reports.BudgetMonth(2026, 8), [["", "PG&E", "100"]]),
               reports.BudgetHistoryRows(reports.BudgetMonth(2026, 12), future))
    _, payload = _report(monkeypatch, [["", "PG&E", "0"]], month=11,
        schedule=[BILL_SCHEDULE_HEADERS, ["pge", "PG&E", "monthly", "22", "", "PG&E"]], history=history)
    december = next(m for m in payload["calendarContext"] if m["month"] == 12)
    bills = [e for e in december["events"] if e["kind"] == "bill"]
    if actual in {"", "0"}:
        assert len(bills) == 1 and bills[0]["amount"] == 100 and bills[0]["prediction"]
    else:
        assert all(not e.get("amountEstimated") and not e.get("prediction") for e in bills)


def test_bills_and_overview_use_identical_baseline_and_actual_zero_suppresses_prediction(monkeypatch):
    from datetime import datetime
    from bookiebot.reports import bill_settings as bills, expense_breakdown as reports
    from bookiebot.sheets import recurring_storage as storage
    from bookiebot.sheets.recurring import BILL_TAB
    from bookiebot.sheets.recurring_charges import BillCharge, CHARGES_TAB, encode_charges, source_anchor
    from unit_tests.sheets.test_recurring import plan
    from unit_tests.sheets.test_recurring_storage import fixture, B
    from unit_tests.support.sheets_repo_stub import InMemoryWorksheet
    p = replace(plan(), id="variable_pge", kind="variable", name="Electricity", source_label="PG&E",
                amount_cents=None, pull_day=22, monthly_source=True, version="v1")
    client, _ = fixture([p])
    client.http_client.rows["November"][0][2] = client.http_client.formulas["November"][0][2] = "0"
    before = deepcopy(client.http_client.rows)
    monkeypatch.setenv("BOOKIEBOT_REIMBURSEMENTS_ENABLED", "false")
    monkeypatch.setattr(bills, "read_workbook", lambda actor, today: storage.read_workbook(actor, today, client=client))
    monkeypatch.setattr(bills, "now_pacific", lambda: datetime(2026, 11, 13, 12))
    monkeypatch.setattr(reports, "now_pacific", lambda: datetime(2026, 11, 13, 12))
    monkeypatch.setattr(reports, "_optional_previous_year_budget_history", lambda *args, **kwargs: ())
    def report():
        return reports.expense_breakdown_client_payload(reports.build_expense_breakdown_report(actor_key=B,
            owner_name="Brian", persons=[], month=reports.BudgetMonth(2026, 11), worksheets=reports.ReportWorksheets(
                shared_expenses=InMemoryWorksheet([]), personal_budget=InMemoryWorksheet(client.http_client.rows["November"]),
                bill_schedule=InMemoryWorksheet(client.http_client.rows[BILL_TAB]),
                bill_charges=InMemoryWorksheet(client.http_client.rows.get(CHARGES_TAB, [])),
                budget_history=(reports.BudgetHistoryRows(reports.BudgetMonth(2026, 10), client.http_client.rows["October"]),))))
    value = bills.listing(B)
    assert value["bills"][0]["prediction"]["amountCents"] == 6023
    event = next(e for e in report()["calendarEvents"] if e["kind"] == "bill")
    assert event["prediction"] == value["bills"][0]["prediction"]
    assert client.http_client.rows == before and not client.http_client.sent
    client.http_client.rows["November"][0][2] = client.http_client.formulas["November"][0][2] = "123.45"
    assert bills.listing(B)["bills"][0]["prediction"] is None
    assert report()["modeViews"]["projected"]["metrics"]["totalExpenses"] == 123.45
    # A confirmed zero is an actual occurrence, rather than a missing amount.
    client.http_client.rows["November"][0][2] = client.http_client.formulas["November"][0][2] = "0"
    charge = BillCharge(p.id, "2026-11", "2026-11-01", p.source_label, p.category, 1, 1, 3,
                        source_anchor(p.id, "2026-11"), 6023, True)
    client.http_client.rows[CHARGES_TAB] = client.http_client.formulas[CHARGES_TAB] = encode_charges([charge], [])
    client.http_client.properties[CHARGES_TAB] = {"title": CHARGES_TAB, "sheetId": 7}
    assert bills.listing(B)["bills"][0]["prediction"] is None
    assert report()["modeViews"]["projected"]["metrics"]["totalExpenses"] == 0
    assert not client.http_client.sent
