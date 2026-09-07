import asyncio
import threading
from types import SimpleNamespace

import pytest

from bookiebot.reports import web as reports_web


PAYLOAD = dict(actor_key="a", owner_name="Owner", persons=["A", "B"], year=2026, month=9)


@pytest.mark.asyncio
async def test_eight_distinct_months_share_one_annual_read_until_refresh_or_expiry(monkeypatch):
    clock = [100.0]
    calls = []
    monkeypatch.setattr(reports_web, "time", SimpleNamespace(monotonic=lambda: clock[0]))
    def year(payload):
        calls.append(payload)
        return {month: {"month": month, "revision": len(calls)} for month in range(1, 10)}
    monkeypatch.setattr(reports_web, "_render_live_comparison_year", year)
    monkeypatch.setattr(reports_web, "_render_live_report_data", lambda payload: {"fresh": True})
    builds = reports_web._ReportBuilds()
    try:
        results = await asyncio.gather(*(builds.comparison_data({**PAYLOAD, "month": month}) for month in range(1, 9)))
        assert [result["month"] for result in results] == list(range(1, 9))
        assert {result["revision"] for result in results} == {1}
        assert len(calls) == 1
        clock[0] += reports_web._COMPARISON_READ_SECONDS - .01
        assert (await builds.comparison_data(PAYLOAD))["revision"] == 1
        clock[0] += .01
        assert (await builds.comparison_data(PAYLOAD))["revision"] == 2
        assert await builds.data(PAYLOAD) == {"fresh": True}
        assert (await builds.comparison_data({**PAYLOAD, "month": 8}))["revision"] == 3
    finally:
        await builds.close()
    assert not builds._history_reads and not builds._history_epochs


@pytest.mark.asyncio
async def test_history_cache_is_bounded_and_uses_complete_identity(monkeypatch):
    calls = []
    def year(payload):
        calls.append(payload)
        return {9: {"revision": len(calls)}}
    monkeypatch.setattr(reports_web, "_render_live_comparison_year", year)
    monkeypatch.setenv("BOOKIEBOT_REPORT_MAX_CONCURRENT_BUILDS", "1")
    builds = reports_web._ReportBuilds()
    try:
        first = await builds.comparison_data(PAYLOAD)
        assert await builds.comparison_data({**PAYLOAD, "persons": ["B", "A"]}) == first
        for change in ({"actor_key": "b"}, {"owner_name": "Other"}, {"persons": ["Other"]}, {"year": 2025}):
            assert await builds.comparison_data({**PAYLOAD, **change}) != first
        assert len(calls) == 5
        assert len(builds._history_reads) == builds._capacity
        assert len(builds._history_epochs) <= builds._capacity
    finally:
        await builds.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("refresh_fails", [False, True])
async def test_old_annual_read_cannot_repopulate_cache_after_new_refresh(monkeypatch, refresh_fails):
    started, release = threading.Event(), threading.Event()
    calls = []
    def year(payload):
        calls.append(payload)
        revision = len(calls)
        if revision == 1:
            started.set()
            assert release.wait(3)
        return {8: {"revision": revision}}
    def fresh(payload):
        if refresh_fails:
            raise RuntimeError("refresh failed")
        return {"fresh": True}
    monkeypatch.setattr(reports_web, "_render_live_comparison_year", year)
    monkeypatch.setattr(reports_web, "_render_live_report_data", fresh)
    builds = reports_web._ReportBuilds()
    try:
        old = asyncio.create_task(builds.comparison_data({**PAYLOAD, "month": 8}))
        assert await asyncio.to_thread(started.wait, 1)
        if refresh_fails:
            with pytest.raises(RuntimeError):
                await builds.data(PAYLOAD)
        else:
            await builds.data(PAYLOAD)
        assert (await builds.comparison_data({**PAYLOAD, "month": 8}))["revision"] == 2
        release.set()
        assert (await old)["revision"] == 1
        assert (await builds.comparison_data({**PAYLOAD, "month": 8}))["revision"] == 2
        assert len(calls) == 2
    finally:
        release.set()
        await builds.close()


@pytest.mark.asyncio
async def test_failed_annual_reads_and_partial_catalogs_are_retryable_not_cached(monkeypatch):
    calls = []
    def year(payload):
        calls.append(payload)
        if len(calls) == 1:
            raise RuntimeError("source quota exhausted")
        return {8: {"revision": 2}}
    catalogs = []
    def catalog(payload):
        catalogs.append(payload)
        return {"months": [], "coverage": {"status": "partial" if len(catalogs) == 1 else "complete"}}
    monkeypatch.setattr(reports_web, "_render_live_comparison_year", year)
    monkeypatch.setattr(reports_web, "_render_live_report_catalog", catalog)
    builds = reports_web._ReportBuilds()
    try:
        with pytest.raises(RuntimeError):
            await builds.comparison_data({**PAYLOAD, "month": 8})
        assert (await builds.comparison_data({**PAYLOAD, "month": 8}))["revision"] == 2
        assert (await builds.catalog(PAYLOAD))["coverage"]["status"] == "partial"
        assert (await builds.catalog(PAYLOAD))["coverage"]["status"] == "complete"
        await builds.catalog(PAYLOAD)
        assert len(catalogs) == 2
        # Explicit refresh invalidates metadata too, so newly added tabs appear.
        monkeypatch.setattr(reports_web, "_render_live_report_data", lambda payload: {})
        await builds.data(PAYLOAD)
        await builds.catalog(PAYLOAD)
        assert len(catalogs) == 3
    finally:
        await builds.close()


@pytest.mark.asyncio
async def test_pre_refresh_full_month_cannot_override_fresh_comparison(monkeypatch):
    started, release = threading.Event(), threading.Event()
    def report(payload):
        if payload["month"] == 8:
            started.set()
            assert release.wait(3)
            return {"revision": "old full August"}
        return {"revision": "new September"}
    monkeypatch.setattr(reports_web, "_render_live_report_data", report)
    monkeypatch.setattr(reports_web, "_render_live_comparison_year", lambda payload: {8: {"revision": "new August"}})
    builds = reports_web._ReportBuilds()
    try:
        old = asyncio.create_task(builds.data({**PAYLOAD, "month": 8}))
        assert await asyncio.to_thread(started.wait, 1)
        await builds.data(PAYLOAD)
        # Comparison must neither wait for an obsolete full build nor receive
        # its late handoff after a newer report invalidates the source scope.
        assert await asyncio.wait_for(builds.comparison_data({**PAYLOAD, "month": 8}), 1) == {"revision": "new August"}
        release.set()
        await old
        assert await builds.comparison_data({**PAYLOAD, "month": 8}) == {"revision": "new August"}
    finally:
        release.set()
        await builds.close()


@pytest.mark.asyncio
async def test_rejected_submissions_do_not_grow_epoch_storage(monkeypatch):
    release = threading.Event()
    monkeypatch.setenv("BOOKIEBOT_REPORT_MAX_CONCURRENT_BUILDS", "1")
    def report(payload):
        assert release.wait(3)
        return {}
    monkeypatch.setattr(reports_web, "_render_live_report_data", report)
    builds = reports_web._ReportBuilds()
    try:
        held = [asyncio.create_task(builds.data({**PAYLOAD, "actor_key": str(actor)})) for actor in range(builds._capacity)]
        await asyncio.sleep(0)
        for actor in range(100, 200):
            with pytest.raises(reports_web._ReportBuildBusy):
                await builds.data({**PAYLOAD, "actor_key": str(actor)})
            assert len(builds._history_epochs) <= builds._capacity
    finally:
        release.set()
        await asyncio.gather(*held)
        await builds.close()
    assert not builds._data_epochs
