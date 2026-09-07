import asyncio
from datetime import datetime
import json
from types import SimpleNamespace

from aiohttp import web
from aiohttp.test_utils import make_mocked_request
import pytest

from bookiebot.reports import phone_history as history, phone_app, web as reports_web
from bookiebot.reports.expense_breakdown import BudgetMonth
from bookiebot.sheets.routing import PACIFIC_TZ


NOW = datetime(2026, 9, 7, tzinfo=PACIFIC_TZ)
ACTOR = "676638528590970917"
SESSION = SimpleNamespace(actor_key=ACTOR, owner_key="brian")


@pytest.mark.parametrize("value", ["2026-1", "2026-13", "../2026-01", "1", "", "2026-08&actor=hannah", "2026-10", "0000-01"])
def test_invalid_or_future_month_is_rejected(value):
    with pytest.raises(history.InvalidReportMonthError):
        history.parse_phone_report_month(value, current=NOW)


def test_month_parsing_and_year_boundary():
    assert history.parse_phone_report_month(None, current=NOW) == BudgetMonth(2026, 9)
    assert history.parse_phone_report_month("2025-12", current=NOW) == BudgetMonth(2025, 12)
    assert history.baseline_for_month(BudgetMonth(2026, 1), "previous-month") == BudgetMonth(2025, 12)
    assert history.baseline_for_month(BudgetMonth(2026, 9), "previous-year") == BudgetMonth(2025, 9)
    with pytest.raises(history.InvalidReportMonthError):
        history.baseline_for_month(BudgetMonth(2026, 9), "arbitrary")


def test_catalog_requires_actual_personal_and_shared_tabs_with_bounded_metadata(monkeypatch):
    calls = []
    titles = {"personal-2025": ["December", "Template"], "shared-2025": ["December"],
              "personal-2026": ["August", "September", "October", "Shared Reimbursements"],
              "shared-2026": ["July", "September", "October"]}
    def fetch(key):
        calls.append(key)
        return {"sheets": [{"properties": {"title": title}} for title in titles[key]]}
    monkeypatch.setattr(history, "configured_reimbursement_workbooks", lambda *a: {2025: "personal-2025", 2026: "personal-2026"})
    monkeypatch.setattr(history, "get_budget_spreadsheet_id_for_user", lambda actor, year: f"personal-{year}" if actor == ACTOR else pytest.fail("wrong owner"))
    monkeypatch.setattr(history, "get_shared_expenses_spreadsheet_id", lambda year: f"shared-{year}")
    monkeypatch.setattr("bookiebot.sheets.auth.get_gspread_client", lambda: SimpleNamespace(http_client=SimpleNamespace(fetch_sheet_metadata=fetch)))
    result = history.load_phone_month_catalog(ACTOR, current=NOW)
    assert result["months"] == [{"value": "2026-09", "label": "September 2026"}, {"value": "2025-12", "label": "December 2025"}]
    assert calls == ["personal-2025", "shared-2025", "personal-2026", "shared-2026"]
    titles["shared-2026"].append("August")
    result = history.load_phone_month_catalog(ACTOR, current=NOW)
    assert result["months"][1]["value"] == "2026-08"
    assert result["coverage"]["status"] == "complete"


def test_failed_metadata_is_incomplete_not_missing_history(monkeypatch):
    monkeypatch.setattr(history, "configured_reimbursement_workbooks", lambda *a: {2026: "personal"})
    monkeypatch.setattr(history, "get_budget_spreadsheet_id_for_user", lambda *a: "personal")
    monkeypatch.setattr(history, "get_shared_expenses_spreadsheet_id", lambda *a: "shared")
    monkeypatch.setattr("bookiebot.sheets.auth.get_gspread_client", lambda: SimpleNamespace(http_client=SimpleNamespace(fetch_sheet_metadata=lambda *a: {})))
    result = history.load_phone_month_catalog(ACTOR, current=NOW)
    assert result["months"] == []
    assert result["coverage"] == {"status": "unavailable", "unavailableYears": [2026]}


@pytest.mark.asyncio
async def test_bounded_selection_rejects_before_reads_and_uses_trusted_identity():
    calls = []
    async def catalog(payload):
        calls.append(payload)
        return {"months": [{"value": "2026-08"}], "coverage": {"status": "complete", "unavailableYears": []}}
    app = web.Application()
    app[reports_web._REPORT_BUILDS] = SimpleNamespace(catalog=catalog)
    request = make_mocked_request("GET", "/?actor_key=hannah", app=app)
    assert await history.available_phone_month(request, SESSION, None, current=NOW) == BudgetMonth(2026, 9)
    with pytest.raises(history.InvalidReportMonthError):
        await history.available_phone_month(request, SESSION, "bad", current=NOW)
    assert calls == []
    assert await history.available_phone_month(request, SESSION, "2026-08", current=NOW) == BudgetMonth(2026, 8)
    assert calls[0]["actor_key"] == ACTOR
    assert calls[0]["persons"] == ["Brian (BofA)"]
    with pytest.raises(history.UnavailableReportMonthError):
        await history.available_phone_month(request, SESSION, "2026-07", current=NOW)


@pytest.mark.asyncio
async def test_catalog_and_report_builds_share_bounds_and_keep_representations_separate(monkeypatch):
    calls = []
    monkeypatch.setattr(reports_web, "_render_live_report_catalog", lambda payload: calls.append("catalog") or {"months": []})
    monkeypatch.setattr(reports_web, "_render_live_report_data", lambda payload: calls.append("data") or {"financial": "report"})
    builds = reports_web._ReportBuilds()
    payload = history.phone_report_payload(SESSION, BudgetMonth(2026, 9))
    first, second, report = await asyncio.gather(builds.catalog(payload), builds.catalog(payload), builds.data(payload))
    assert first == second == {"months": []}
    assert report == {"financial": "report"}
    assert sorted(calls) == ["catalog", "data"]
    await builds.close()


@pytest.mark.asyncio
async def test_history_endpoints_require_session_and_recheck_revocation(monkeypatch):
    calls = []
    async def no_session(_request):
        return None
    monkeypatch.setattr(phone_app, "_session", no_session)
    request = make_mocked_request("GET", "/app/expenses/months")
    assert (await history._months(request)).status == 401
    assert (await history._comparison(request)).status == 401
    async def session(_request):
        calls.append("session")
        return SESSION if len(calls) == 1 else None
    monkeypatch.setattr(phone_app, "_session", session)
    async def catalog(*args, **kwargs):
        return {"secret": "must not leak"}
    monkeypatch.setattr(history, "phone_month_catalog", catalog)
    response = await history._months(request)
    assert response.status == 401
    assert "secret" not in response.text


@pytest.mark.asyncio
async def test_refresh_then_comparison_does_not_rebuild_the_just_loaded_month(monkeypatch):
    calls = []
    async def session(_request):
        return SESSION
    async def catalog(*args, **kwargs):
        return {"months": [{"value": "2026-09"}, {"value": "2026-08"}],
                "coverage": {"status": "complete", "unavailableYears": []}}
    def data(payload):
        calls.append(payload["month"])
        # Repeated full builds consume Sheets quota, even when the app already
        # has this exact current-month result from its just-completed refresh.
        if calls.count(9) > 1:
            raise RuntimeError("Synthetic source read budget exceeded")
        return {"ownerName": payload["owner_name"], "year": payload["year"], "month": payload["month"],
                "comparisonData": {"recordedExpenses": [], "recordedIncome": [], "scheduledExpenses": [],
                                   "unitemizedIncome": 0, "unitemizedExpenses": 0}}
    monkeypatch.setattr(phone_app, "_session", session)
    monkeypatch.setattr(phone_app, "now_pacific", lambda: NOW)
    monkeypatch.setattr(history, "now_pacific", lambda: NOW)
    monkeypatch.setattr(history, "phone_month_catalog", catalog)
    monkeypatch.setattr(reports_web, "_render_live_report_data", data)
    app = web.Application()
    builds = app[reports_web._REPORT_BUILDS] = reports_web._ReportBuilds()
    try:
        refreshed = await phone_app._report_data(make_mocked_request("GET", "/app/expenses/data", app=app))
        assert refreshed.status == 200
        comparison = await history._comparison(make_mocked_request(
            "GET", "/app/expenses/comparison?month=2026-09&compare_month=2026-08", app=app))
        assert comparison.status == 200
        assert calls == [9, 8]
        assert comparison.headers["Cache-Control"] == "private, no-store"
    finally:
        await builds.close()


@pytest.mark.asyncio
async def test_comparison_route_ignores_caller_owner_and_returns_missing_baseline_explicitly(monkeypatch):
    calls = []
    async def session(_request):
        return SESSION
    monkeypatch.setattr(phone_app, "_session", session)
    monkeypatch.setattr(history, "now_pacific", lambda: NOW)
    async def catalog(*args, **kwargs):
        return {"months": [{"value": "2026-09"}], "coverage": {"status": "complete", "unavailableYears": []}}
    monkeypatch.setattr(history, "phone_month_catalog", catalog)
    async def data(payload):
        calls.append(payload)
        return {"ownerName": payload["owner_name"], "year": payload["year"], "month": payload["month"],
                "comparisonData": {"recordedExpenses": [], "recordedIncome": [], "scheduledExpenses": [], "unitemizedIncome": 0, "unitemizedExpenses": 0}}
    app = web.Application()
    app[reports_web._REPORT_BUILDS] = SimpleNamespace(data=data, comparison_data=data)
    request = make_mocked_request("GET", "/app/expenses/comparison?month=2026-09&actor_key=hannah&owner_name=Hannah", app=app)
    response = await history._comparison(request)
    assert response.status == 200
    result = json.loads(response.text)
    assert result["status"] == "unavailable"
    assert result["baseline"] is None
    assert result["changeAmount"] is None
    assert calls[0]["actor_key"] == ACTOR
    assert calls[0]["persons"] == ["Brian (BofA)"]
    assert response.headers["Cache-Control"] == "private, no-store"


@pytest.mark.asyncio
async def test_custom_comparison_reads_both_months_concurrently_and_preserves_matching_days(monkeypatch):
    """A paired comparison must fit one live-build interval, not two in sequence."""
    entered = []
    both_started = asyncio.Event()
    async def session(_request):
        return SESSION
    async def catalog(*args, **kwargs):
        return {"months": [{"value": "2026-09"}, {"value": "2025-09"}],
                "coverage": {"status": "complete", "unavailableYears": []}}
    async def data(payload):
        entered.append(payload)
        if len(entered) == 2:
            both_started.set()
        await asyncio.wait_for(both_started.wait(), 1)
        year, month = payload["year"], payload["month"]
        return {"ownerName": payload["owner_name"], "year": year, "month": month,
                "comparisonData": {"recordedExpenses": [
                    {"date": f"{year}-{month:02d}-01", "amount": 25 if year == 2026 else 50},
                    {"date": f"{year}-{month:02d}-20", "amount": 1000}],
                    "recordedIncome": [], "scheduledExpenses": [],
                    "unitemizedIncome": 0, "unitemizedExpenses": 0}}
    monkeypatch.setattr(phone_app, "_session", session)
    monkeypatch.setattr(history, "now_pacific", lambda: NOW)
    monkeypatch.setattr(history, "phone_month_catalog", catalog)
    app = web.Application()
    app[reports_web._REPORT_BUILDS] = SimpleNamespace(data=data, comparison_data=data)
    history.register_phone_history_routes(app)
    from aiohttp.test_utils import TestClient, TestServer
    async with TestClient(TestServer(app)) as client:
        response = await client.get("/app/expenses/comparison?month=2026-09&compare_month=2025-09&actor_key=hannah")
        result = await response.json()
        assert response.status == 200
        assert response.headers["Cache-Control"] == "private, no-store"
    assert result["baselineMonth"] == "2025-09"
    assert result["baselineKind"] == "selected-month"
    assert result["throughDay"] == 7
    assert result["selected"]["datedSpending"] == 25
    assert result["baseline"]["datedSpending"] == 50
    assert result["changeAmount"] == -25
    assert all(payload["actor_key"] == ACTOR and payload["persons"] == ["Brian (BofA)"] for payload in entered)


@pytest.mark.asyncio
@pytest.mark.parametrize("baseline", ["2026-09", "2026-10", "", "2026-13", "2026-1", "0000-01", "../2025-01"])
async def test_custom_comparison_rejects_same_future_and_invalid_month_before_reads(monkeypatch, baseline):
    async def session(_request):
        return SESSION
    async def catalog(*args, **kwargs):
        pytest.fail("Invalid comparison month must be rejected before sheet reads")
    monkeypatch.setattr(phone_app, "_session", session)
    monkeypatch.setattr(history, "now_pacific", lambda: NOW)
    monkeypatch.setattr(history, "phone_month_catalog", catalog)
    request = make_mocked_request("GET", f"/app/expenses/comparison?month=2026-09&compare_month={baseline}")
    assert (await history._comparison(request)).status == 400


@pytest.mark.asyncio
async def test_missing_custom_month_stays_unavailable_instead_of_zero_or_unconfigured_read(monkeypatch):
    calls = []
    async def session(_request):
        return SESSION
    async def catalog(*args, **kwargs):
        return {"months": [{"value": "2026-09"}],
                "coverage": {"status": "partial", "unavailableYears": [2025]}}
    async def data(payload):
        calls.append((payload["year"], payload["month"]))
        return {"ownerName": "Brian", "year": 2026, "month": 9,
                "comparisonData": {"recordedExpenses": [], "recordedIncome": [], "scheduledExpenses": [],
                                   "unitemizedIncome": 0, "unitemizedExpenses": 0}}
    monkeypatch.setattr(phone_app, "_session", session)
    monkeypatch.setattr(history, "now_pacific", lambda: NOW)
    monkeypatch.setattr(history, "phone_month_catalog", catalog)
    app = web.Application()
    app[reports_web._REPORT_BUILDS] = SimpleNamespace(data=data, comparison_data=data)
    request = make_mocked_request("GET", "/app/expenses/comparison?month=2026-09&compare_month=2025-09", app=app)
    result = json.loads((await history._comparison(request)).text)
    assert result["status"] == "unavailable"
    assert result["baseline"] is None and result["changeAmount"] is None
    assert "could not be checked" in result["coverageNote"]
    assert calls == [(2026, 9)]
