"""Safe quota diagnostics; provider messages never enter report responses/logs."""
import json
from types import SimpleNamespace

from aiohttp import web
from aiohttp.test_utils import make_mocked_request
from gspread.exceptions import APIError
import pytest
import requests

from bookiebot.reports import phone_app, phone_history, read_errors
from bookiebot.reports.app_access import AppSession
from bookiebot.sheets.routing import DEFAULT_BRIAN_DISCORD_USER_IDS, SpreadsheetQuotaError

PRIVATE = "synthetic-workbook-id bearer-synthetic-secret private-expense-123.45"


def provider_error(status=429):
    response = requests.Response()
    response.status_code = status
    response._content = json.dumps({"error": {"code": status, "message": PRIVATE}}).encode()
    return APIError(response)


@pytest.mark.parametrize("kind", ["provider", "cause", "context", "routing", "cycle"])
def test_quota_recognition_follows_causal_status_without_parsing_private_text(kind):
    error = provider_error()
    if kind in ("cause", "context", "cycle"):
        outer = RuntimeError(PRIVATE)
        if kind == "context":
            outer.__context__ = error
        else:
            outer.__cause__ = error
        if kind == "cycle":
            error.__cause__ = outer
        error = outer
    elif kind == "routing":
        error = SpreadsheetQuotaError(PRIVATE)
    assert read_errors.is_report_quota_error(error)
    assert not read_errors.is_report_quota_error(RuntimeError("429 " + PRIVATE)), "Error text is not a trusted status code"


@pytest.mark.parametrize("operation", ["refresh", "comparison", "catalog"])
def test_quota_response_and_log_are_safe_and_retryable(caplog, operation):
    error = RuntimeError(PRIVATE)
    error.__cause__ = provider_error()
    response = read_errors.report_read_failure(error, operation=operation, message="Report temporarily unavailable.")
    assert response.status == 503
    assert response.headers["Retry-After"] == "60"
    assert response.headers["Cache-Control"] == "private, no-store"
    body = json.loads(response.text)
    assert body["code"] == "sheets_rate_limited"
    assert "Google Sheets" in body["error"] and "minute" in body["error"]
    assert PRIVATE not in response.text and PRIVATE not in caplog.text
    assert f"operation={operation} error=RuntimeError upstream_status=429" in caplog.text
    assert all(record.exc_info is None for record in caplog.records)


def test_other_read_failure_is_logged_without_raw_provider_details(caplog):
    response = read_errors.report_read_failure(provider_error(500), operation="refresh", message="Refresh unavailable.")
    assert response.status == 503
    assert json.loads(response.text) == {"code": "report_unavailable", "error": "Refresh unavailable."}
    assert "Retry-After" not in response.headers
    assert "upstream_status=500" in caplog.text
    assert PRIVATE not in caplog.text and PRIVATE not in response.text


@pytest.mark.parametrize("kind", ["read", "connect", "builtin", "cause", "context", "cycle"])
def test_timeout_recognition_uses_exception_types_and_causal_chain(kind):
    error = requests.ReadTimeout(PRIVATE)
    if kind == "connect":
        error = requests.ConnectTimeout(PRIVATE)
    elif kind == "builtin":
        error = TimeoutError(PRIVATE)
    elif kind in {"cause", "context", "cycle"}:
        outer = RuntimeError(PRIVATE)
        if kind == "context":
            outer.__context__ = error
        else:
            outer.__cause__ = error
        if kind == "cycle":
            error.__cause__ = outer
        error = outer
    assert read_errors.is_report_timeout_error(error)
    misleading = RuntimeError("ReadTimeout: timed out " + PRIVATE)
    misleading.__cause__ = ValueError(PRIVATE)
    misleading.__cause__.__cause__ = misleading
    assert not read_errors.is_report_timeout_error(misleading)


@pytest.mark.parametrize("operation", ["refresh", "comparison", "catalog"])
def test_timeout_response_and_log_identify_source_without_private_details(caplog, operation):
    error = RuntimeError(PRIVATE)
    error.__cause__ = requests.ReadTimeout(PRIVATE)
    response = read_errors.report_read_failure(error, operation=operation, message="Refresh unavailable.")
    assert response.status == 503
    assert response.headers["Retry-After"] == "15"
    assert response.headers["Cache-Control"] == "private, no-store"
    body = json.loads(response.text)
    assert body["code"] == "source_timeout"
    assert "Google Sheets" in body["error"] and "too long" in body["error"]
    assert PRIVATE not in response.text and PRIVATE not in caplog.text
    assert f"operation={operation} error=RuntimeError upstream_status=unknown" in caplog.text
    assert all(record.exc_info is None for record in caplog.records)


def test_quota_takes_precedence_over_timeout_in_the_same_causal_chain():
    error = requests.ReadTimeout(PRIVATE)
    error.__cause__ = provider_error()
    response = read_errors.report_read_failure(error, operation="refresh", message="Refresh unavailable.")
    assert json.loads(response.text)["code"] == "sheets_rate_limited"
    assert response.headers["Retry-After"] == "60"


@pytest.mark.asyncio
@pytest.mark.parametrize("route", ["refresh", "comparison", "catalog"])
@pytest.mark.parametrize("failure,code,retry_after", [
    (provider_error, "sheets_rate_limited", "60"),
    (lambda: requests.ReadTimeout(PRIVATE), "source_timeout", "15"),
])
async def test_phone_read_routes_surface_source_errors_without_exposing_payload(
    monkeypatch, caplog, route, failure, code, retry_after,
):
    async def session(_request):
        return AppSession(DEFAULT_BRIAN_DISCORD_USER_IDS[0], "brian", 9999999999)

    async def limited(*_args, **_kwargs):
        raise failure()

    monkeypatch.setattr(phone_app, "_session", session)
    monkeypatch.setattr(phone_app, "_valid_owner", lambda _session: SimpleNamespace(name="Synthetic", expense_persons=[]))
    monkeypatch.setattr(phone_history, "available_phone_month", limited)
    monkeypatch.setattr(phone_history, "phone_month_catalog", limited)
    handlers = {"refresh": phone_app._report_data, "comparison": phone_history._comparison, "catalog": phone_history._months}
    request = make_mocked_request("GET", "/app/expenses/data", app=web.Application())
    response = await handlers[route](request)
    assert response.status == 503
    assert response.headers["Retry-After"] == retry_after
    assert json.loads(response.text)["code"] == code
    assert f"operation={route}" in caplog.text
    assert PRIVATE not in caplog.text and PRIVATE not in response.text
