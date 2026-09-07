import asyncio
import threading
from types import SimpleNamespace

from aiohttp import web
from aiohttp.test_utils import make_mocked_request
import pytest

from bookiebot.reports import expense_breakdown, web as reports_web
from bookiebot.sheets.routing import get_current_discord_user_id


@pytest.fixture
def report_app(tmp_path, monkeypatch):
    monkeypatch.setenv("BOOKIEBOT_REPORT_DIR", str(tmp_path))
    monkeypatch.setenv("BOOKIEBOT_REPORT_SIGNING_SECRET", "test-only-secret")
    app = web.Application()
    reports_web.register_report_routes(app)
    return app


def _token(*, actor="owner-a", filename="expense-breakdown-a-2026-06-test.html", **kwargs):
    return reports_web.create_expense_report_token(
        actor_key=actor, owner_name=actor, persons=[actor], year=2026, month=6,
        filename=filename, **kwargs,
    )


def _request(app, token, *, filename=None):
    if filename:
        return make_mocked_request(
            "GET", f"/reports/{filename}?token={token}", app=app, match_info={"name": filename},
        )
    return make_mocked_request("GET", f"/reports/expense-breakdown?token={token}&live=1", app=app)


@pytest.mark.asyncio
@pytest.mark.parametrize("token_kind", ["missing", "tampered", "expired", "other_file"])
async def test_static_report_requires_valid_token_bound_to_filename(report_app, tmp_path, monkeypatch, token_kind):
    filename = "expense-breakdown-a-2026-06-test.html"
    (tmp_path / filename).write_text("private report")
    token = _token()
    if token_kind == "missing":
        token = ""
    elif token_kind == "tampered":
        token = "x" + token
    elif token_kind == "expired":
        monkeypatch.setattr(reports_web, "time", SimpleNamespace(time=lambda: 1000))
        token = _token(ttl_seconds=60)
        monkeypatch.setattr(reports_web, "time", SimpleNamespace(time=lambda: 1061))
    else:
        token = _token(filename="another-report.html")
    with pytest.raises(web.HTTPNotFound):
        await reports_web._serve_report(_request(report_app, token, filename=filename))


@pytest.mark.asyncio
async def test_valid_filename_token_serves_only_its_snapshot_without_caching(report_app, tmp_path):
    filename = "expense-breakdown-a-2026-06-test.html"
    (tmp_path / filename).write_text("private report")
    response = await reports_web._serve_report(_request(report_app, _token(), filename=filename))
    assert response.status == 200
    assert response.headers["Cache-Control"] == "private, no-store"


@pytest.mark.asyncio
async def test_live_report_failure_preserves_signed_snapshot_fallback(report_app, tmp_path, monkeypatch):
    filename = "expense-breakdown-a-2026-06-test.html"
    (tmp_path / filename).write_text("last successful report")
    def fail(_payload):
        raise RuntimeError("Sheets unavailable")
    monkeypatch.setattr(reports_web, "_render_live_report", fail)
    response = await reports_web._serve_expense_breakdown_report(_request(report_app, _token()))
    assert isinstance(response, web.FileResponse)
    assert response.status == 200
    await report_app[reports_web._REPORT_BUILDS].close()


@pytest.mark.asyncio
async def test_report_builds_yield_coalesce_and_survive_one_disconnected_request(report_app, monkeypatch):
    started = threading.Event()
    release = threading.Event()
    calls = []
    def build(**kwargs):
        calls.append((kwargs["actor_key"], get_current_discord_user_id()))
        started.set()
        assert release.wait(2), "Report worker was not released; event loop may be blocked"
        return kwargs["actor_key"]
    def render(report):
        assert get_current_discord_user_id() == report
        return f"<html>{report}</html>"
    monkeypatch.setattr(expense_breakdown, "build_expense_breakdown_report", build)
    monkeypatch.setattr(expense_breakdown, "render_expense_breakdown_html", render)
    first = asyncio.create_task(reports_web._serve_expense_breakdown_report(_request(report_app, _token())))
    assert await asyncio.to_thread(started.wait, 1)
    assert not first.done()
    second = asyncio.create_task(reports_web._serve_expense_breakdown_report(_request(report_app, _token(filename="same-owner-different-snapshot.html"))))
    await asyncio.sleep(0)
    first.cancel()
    with pytest.raises(asyncio.CancelledError):
        await first
    release.set()
    response = await second
    assert response.text == "<html>owner-a</html>"
    assert response.headers["Cache-Control"] == "private, no-store"
    assert calls == [("owner-a", "owner-a")]
    assert get_current_discord_user_id() is None
    # Sharing is in-flight only: the next refresh observes current sheet edits.
    await reports_web._serve_expense_breakdown_report(_request(report_app, _token()))
    assert len(calls) == 2
    await report_app[reports_web._REPORT_BUILDS].close()


@pytest.mark.asyncio
async def test_report_build_limit_keeps_actors_separate_and_bounds_queue(monkeypatch):
    monkeypatch.setenv("BOOKIEBOT_REPORT_MAX_CONCURRENT_BUILDS", "1")
    builds = reports_web._ReportBuilds()
    started = threading.Event()
    release = threading.Event()
    calls = []
    def render(payload):
        calls.append(payload["actor_key"])
        started.set()
        assert release.wait(2)
        return payload["actor_key"]
    monkeypatch.setattr(reports_web, "_render_live_report", render)
    def payload(actor):
        return dict(actor_key=actor, owner_name="Shared display name", persons=["Shared person"], year=2026, month=6)
    requests = [asyncio.create_task(builds.render(payload(f"owner-{i}"))) for i in range(4)]
    try:
        assert await asyncio.to_thread(started.wait, 1)
        assert calls == ["owner-0"]
        with pytest.raises(RuntimeError, match="busy"):
            await builds.render(payload("owner-overflow"))
        release.set()
        assert await asyncio.gather(*requests) == [f"owner-{i}" for i in range(4)]
        assert calls == [f"owner-{i}" for i in range(4)]
    finally:
        release.set()
        await builds.close()


@pytest.mark.asyncio
async def test_live_report_capacity_returns_retryable_response_without_snapshot(report_app, monkeypatch):
    async def busy(_payload):
        raise reports_web._ReportBuildBusy("Report refresh is busy")
    monkeypatch.setattr(report_app[reports_web._REPORT_BUILDS], "render", busy)
    with pytest.raises(web.HTTPServiceUnavailable) as error:
        await reports_web._serve_expense_breakdown_report(_request(report_app, _token()))
    assert error.value.headers["Retry-After"] == "5"


@pytest.mark.asyncio
async def test_comparison_handoff_is_short_lived_bounded_and_identity_scoped(monkeypatch):
    monkeypatch.setenv("BOOKIEBOT_REPORT_MAX_CONCURRENT_BUILDS", "1")
    clock = [100.0]
    monkeypatch.setattr(reports_web, "time", SimpleNamespace(monotonic=lambda: clock[0]))
    calls = []
    def render(payload):
        calls.append(payload)
        return {"revision": len(calls)}
    monkeypatch.setattr(reports_web, "_render_live_report_data", render)
    monkeypatch.setattr(reports_web, "_render_live_comparison_year", lambda payload: {9: render(payload)})
    builds = reports_web._ReportBuilds()
    payload = dict(actor_key="a", owner_name="Owner", persons=["B", "A"], year=2026, month=9)
    try:
        first = await builds.data(payload)
        assert await builds.comparison_data({**payload, "persons": ["A", "B"]}) == first
        fresh = await builds.data(payload)
        assert fresh != first, "Manual refresh must bypass the comparison handoff"
        assert await builds.comparison_data(payload) == fresh
        clock[0] += reports_web._COMPARISON_HANDOFF_SECONDS
        assert await builds.comparison_data(payload) != fresh
        for change in ({"actor_key": "b"}, {"owner_name": "Other"}, {"persons": ["Other"]}, {"year": 2025}, {"month": 8}):
            count = len(calls)
            await builds.data({**payload, **change})
            assert len(calls) == count + 1
        assert len(builds._comparison_handoffs) == builds._capacity
    finally:
        await builds.close()
    assert not builds._comparison_handoffs


@pytest.mark.asyncio
@pytest.mark.parametrize("fail", [False, True])
async def test_comparison_waits_for_newer_refresh_and_never_revives_old_success(monkeypatch, fail):
    started, release = threading.Event(), threading.Event()
    calls = []
    def render(_payload):
        calls.append(len(calls) + 1)
        if len(calls) == 2:
            started.set()
            assert release.wait(2)
            if fail:
                raise RuntimeError("Synthetic refresh failure")
        return {"revision": len(calls)}
    monkeypatch.setattr(reports_web, "_render_live_report_data", render)
    monkeypatch.setattr(reports_web, "_render_live_comparison_year", lambda payload: {9: render(payload)})
    builds = reports_web._ReportBuilds()
    payload = dict(actor_key="a", owner_name="Owner", persons=["A"], year=2026, month=9)
    try:
        assert (await builds.data(payload))["revision"] == 1
        refresh = asyncio.create_task(builds.data(payload))
        assert await asyncio.to_thread(started.wait, 1)
        comparison = asyncio.create_task(builds.comparison_data(payload))
        await asyncio.sleep(0)
        assert not comparison.done(), "Comparison must not show the previous successful refresh"
        release.set()
        results = await asyncio.gather(refresh, comparison, return_exceptions=True)
        assert calls == [1, 2], "Overlapping callers share the actual newer read"
        if fail:
            assert all(isinstance(result, RuntimeError) for result in results)
            assert not builds._comparison_handoffs
            assert (await builds.comparison_data(payload))["revision"] == 3
        else:
            assert results == [{"revision": 2}, {"revision": 2}]
            assert (await builds.comparison_data(payload))["revision"] == 2
    finally:
        release.set()
        await builds.close()
