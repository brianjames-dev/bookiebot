import asyncio
import threading
from types import SimpleNamespace

import gspread
from google.auth.credentials import AnonymousCredentials
import pytest
import requests

from bookiebot.sheets import auth


class _Spreadsheet:
    def __init__(self, worksheet):
        self._worksheet = worksheet
        self.worksheet_calls = 0

    def worksheet(self, name):
        self.worksheet_calls += 1
        return self._worksheet


class _GC:
    def __init__(self, spreadsheet):
        self._spreadsheet = spreadsheet
        self.open_calls = 0

    def open_by_key(self, key):
        self.open_calls += 1
        return self._spreadsheet


def test_month_worksheet_is_cached_by_spreadsheet_and_month(monkeypatch):
    worksheet = object()
    spreadsheet = _Spreadsheet(worksheet)
    gc = _GC(spreadsheet)
    monkeypatch.setattr(auth, "_MONTH_WORKSHEET_BY_KEY", {})
    monkeypatch.setattr(auth, "_get_gc", lambda: gc)
    monkeypatch.setattr(auth, "get_current_month_name", lambda: "August")

    first = auth._open_month_sheet("sheet-id")
    second = auth._open_month_sheet("sheet-id")

    assert first is worksheet
    assert second is worksheet
    assert gc.open_calls == 1
    assert spreadsheet.worksheet_calls == 1


def test_new_bill_schedule_has_room_for_expected_amount_column(monkeypatch):
    created = []

    class ScheduleBook:
        def worksheet(self, _name):
            raise gspread.WorksheetNotFound("Missing schedule")

        def add_worksheet(self, **kwargs):
            created.append(kwargs)
            return SimpleNamespace(id=27, col_count=kwargs["cols"])

        def batch_update(self, _body):
            pass

    monkeypatch.setattr(auth, "_BILL_SCHEDULE_WORKSHEET_BY_KEY", {})
    monkeypatch.setattr(auth, "_get_gc", lambda: _GC(ScheduleBook()))
    monkeypatch.setattr(auth, "get_budget_spreadsheet_id_for_user", lambda *_args: "synthetic-budget")
    first = auth.get_bill_schedule_worksheet()
    assert first.col_count == 10
    assert auth.get_bill_schedule_worksheet() is first
    assert created == [{"title": "_BookieBot Bill Schedule", "rows": 100, "cols": 10}]


def _authorized_client(monkeypatch):
    credentials = AnonymousCredentials()
    client = gspread.Client(auth=credentials)
    monkeypatch.setattr(auth, "_GC", None)
    monkeypatch.setenv("GOOGLE_SERVICE_ACCOUNT_JSON", '{"client_email":"synthetic@example.invalid"}')
    monkeypatch.setattr(auth.Credentials, "from_service_account_info", lambda *_args, **_kwargs: credentials)
    monkeypatch.setattr(auth.gspread, "authorize", lambda _credentials: client)
    return client, credentials


def test_client_bounds_sheets_and_credential_transport_before_publishing(monkeypatch):
    client, credentials = _authorized_client(monkeypatch)
    requests_seen = []
    refresh_seen = []

    def request(_session, method, url, **kwargs):
        requests_seen.append(kwargs["timeout"])
        response = requests.Response()
        response.status_code = 200
        response._content = b"{}"
        return response

    def before_request(refresh, *_args):
        # Exercise AuthorizedSession's real propagation of the Sheets timeout
        # into its credential transport, without any external HTTP call.
        refresh("https://synthetic.invalid/token")

    monkeypatch.setattr(requests.Session, "request", request)
    monkeypatch.setattr(credentials, "before_request", before_request)
    monkeypatch.setattr(client.http_client.session, "_auth_request", lambda *_args, **kwargs: refresh_seen.append(kwargs["timeout"]))
    original_set_timeout = client.set_timeout

    def configure(timeout):
        assert auth._GC is None, "Another worker must never observe a client before its timeout is configured"
        original_set_timeout(timeout)

    monkeypatch.setattr(client, "set_timeout", configure)
    assert auth.get_gspread_client() is client
    client.http_client.request("GET", "https://synthetic.invalid/sheets")
    assert requests_seen == [(5, 20)]
    assert refresh_seen == [(5, 20)]
    assert auth.get_gspread_client() is client


def test_failed_timeout_configuration_does_not_poison_cached_client(monkeypatch):
    client, _ = _authorized_client(monkeypatch)
    original_set_timeout = client.set_timeout
    monkeypatch.setattr(client, "set_timeout", lambda _timeout: (_ for _ in ()).throw(RuntimeError("Configuration failed")))
    with pytest.raises(RuntimeError, match="Configuration failed"):
        auth.get_gspread_client()
    assert auth._GC is None
    monkeypatch.setattr(client, "set_timeout", original_set_timeout)
    assert auth.get_gspread_client() is client
    assert client.http_client.timeout == (5, 20)


@pytest.mark.asyncio
async def test_cancelled_report_waiters_recover_after_transport_timeout(monkeypatch):
    from bookiebot.reports import web as reports_web

    client, _ = _authorized_client(monkeypatch)
    client = auth.get_gspread_client()
    monkeypatch.setenv("BOOKIEBOT_REPORT_MAX_CONCURRENT_BUILDS", "1")
    builds = reports_web._ReportBuilds()
    started = threading.Event()
    timeout_elapsed = threading.Event()
    calls = []

    def request(_session, method, url, **kwargs):
        assert kwargs["timeout"] == (5, 20)
        calls.append(url)
        if len(calls) == 1:
            started.set()
            assert timeout_elapsed.wait(2)
            raise requests.ReadTimeout("Synthetic stalled Sheets read")
        response = requests.Response()
        response.status_code = 200
        response._content = b"{}"
        return response

    monkeypatch.setattr(requests.Session, "request", request)

    def render(payload):
        client.http_client.request("GET", "https://synthetic.invalid/sheets")
        return {"month": payload["month"]}

    monkeypatch.setattr(reports_web, "_render_live_report_data", render)
    payload = dict(actor_key="synthetic", owner_name="Synthetic", persons=["Synthetic"], year=2026, month=9)
    first = asyncio.create_task(builds.data(payload))
    try:
        assert await asyncio.to_thread(started.wait, 1)
        first.cancel()
        with pytest.raises(asyncio.CancelledError):
            await first
        retry = asyncio.create_task(builds.data(payload))
        comparison = asyncio.create_task(builds.data({**payload, "month": 8}))
        await asyncio.sleep(0)
        assert len(calls) == 1, "Cancelled callers must not release a still-running worker's concurrency slot"
        timeout_elapsed.set()
        with pytest.raises(requests.ReadTimeout):
            await retry
        assert await comparison == {"month": 8}
        assert await builds.data(payload) == {"month": 9}, "A fresh retry must work after the timed-out worker exits"
        assert len(calls) == 3
    finally:
        timeout_elapsed.set()
        await builds.close()
