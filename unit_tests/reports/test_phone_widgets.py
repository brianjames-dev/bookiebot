import asyncio
from datetime import datetime, timedelta, timezone
from threading import Event
from types import SimpleNamespace
from urllib.parse import urlsplit

from aiohttp import CookieJar, web
from aiohttp.test_utils import TestClient, TestServer
import pytest
import pytest_asyncio

from bookiebot.reports import phone_app, phone_widgets, widget_store, web as reports_web
from bookiebot.reports.app_access import AppAccessStore
from bookiebot.reports.widget_store import WidgetStore
from bookiebot.sheets.routing import PACIFIC_TZ

BRIAN = "676638528590970917"
HANNAH = "830984827904851969"
ORIGIN = "https://bookiebot.test"
HEADERS = {"X-BookieBot-App": "1", "Origin": ORIGIN}


@pytest_asyncio.fixture
async def client(tmp_path, monkeypatch):
    monkeypatch.setenv("BOOKIEBOT_PUBLIC_BASE_URL", ORIGIN)
    monkeypatch.setattr(phone_app, "_cookie_name", lambda: "bb_phone_local")
    access = AppAccessStore(tmp_path / "access.sqlite3")
    access.initialize()
    widgets = WidgetStore(access)
    widgets.initialize()
    monkeypatch.setattr(phone_app, "build_app_access_store", lambda: access)
    monkeypatch.setattr(phone_widgets, "build_widget_store", lambda: widgets)
    monkeypatch.setattr(widget_store, "build_widget_store", lambda: widgets)
    state = SimpleNamespace(now=datetime.now(PACIFIC_TZ), calls=[], revise=None)
    monkeypatch.setattr(phone_widgets, "now_pacific", lambda: state.now)

    def render(payload):
        state.calls.append(payload)
        data = {"ownerName": payload["owner_name"], "year": payload["year"], "month": payload["month"],
                "generatedAtIso": state.now.isoformat(), "privateItems": ["must never leave this server"],
                "modeViews": {"current": {"metrics": {"incomeAfterExpenses": 1234.56},
                                          "burnRate": {"status": "under", "totalDifference": -22.35}},
                              "projected": {"metrics": {"incomeAfterExpenses": 2345.67},
                                            "burnRate": {"status": "over", "totalDifference": 10.55}}}}
        return state.revise(data) if state.revise else data
    monkeypatch.setattr(reports_web, "_render_live_report_data", render)
    app = web.Application()
    reports_web.register_report_routes(app)
    async with TestClient(TestServer(app), cookie_jar=CookieJar(unsafe=True)) as http:
        yield SimpleNamespace(http=http, access=access, widgets=widgets, state=state, app=app)


def connect(client, actor=BRIAN, owner="brian"):
    paired = client.access.consume_pairing(client.access.issue_pairing(actor, owner))
    assert paired is not None
    client.http.session.cookie_jar.update_cookies({"bb_phone_local": paired[0]})
    return paired[0]


def grant(client, actor=BRIAN, owner="brian", mode="current"):
    issued = client.widgets.issue_pairing(actor, owner, f"{owner}'s iPhone", mode)
    result = client.widgets.consume_pairing(issued["pairingToken"])
    assert result is not None
    return result


async def read(client, token, suffix=""):
    return await client.http.get("/app/widgets/data" + suffix, headers={"Authorization": f"Bearer {token}"})


@pytest.mark.asyncio
async def test_settings_pair_once_and_list_no_secrets(client):
    assert (await client.http.get("/app/widgets/settings")).status == 401
    connect(client)
    response = await client.http.post("/app/widgets/settings", json={"operation": "pair", "label": "Brian's iPhone", "mode": "projected"}, headers=HEADERS)
    assert response.status == 200
    data = await response.json()
    assert response.headers["Cache-Control"] == "private, no-store"
    link = urlsplit(data["pairing"]["setupCode"])
    assert link.scheme == "https" and link.netloc == "bookiebot.test" and not link.query
    assert link.path == "/app/widgets/connect" and link.fragment.startswith("bbw_pair_")
    preview = await client.http.get("/app/widgets/connect")
    assert preview.status == 200 and link.fragment not in await preview.text()
    client.http.session.cookie_jar.clear()
    paired = await client.http.post("/app/widgets/pair", json={"pairingToken": link.fragment})
    assert paired.status == 200 and not paired.cookies
    values = await paired.json()
    assert values["ownerName"] == "Brian" and values["mode"] == "projected"
    assert values["token"].startswith("bbw_read_")
    assert (await client.http.post("/app/widgets/pair", json={"pairingToken": link.fragment})).status == 401
    connect(client)
    listed = await (await client.http.get("/app/widgets/settings")).json()
    assert listed["connections"][0]["status"] == "active"
    assert listed["connections"][0]["id"] == values["connectionId"]
    assert "bbw_" not in str(listed) and "actor_key" not in str(listed) and "token_hash" not in str(listed)
    assert listed["scriptUrl"] == "/app/widgets/script"


@pytest.mark.asyncio
@pytest.mark.parametrize("headers", [{}, {**HEADERS, "Origin": "null"}, {**HEADERS, "Origin": "https://evil.test"}, {**HEADERS, "Sec-Fetch-Site": "cross-site"}])
async def test_settings_cross_site_denied(client, headers):
    connect(client)
    response = await client.http.post("/app/widgets/settings", json={"operation": "pair", "label": "Phone", "mode": "current"}, headers=headers)
    assert response.status == 403
    assert client.widgets.list_connections("brian")["connections"] == []


@pytest.mark.asyncio
async def test_settings_isolation_mode_and_revoke(client):
    brian, bg = grant(client)
    hannah, hg = grant(client, HANNAH, "hannah")
    connect(client, HANNAH, "hannah")
    listed = await (await client.http.get("/app/widgets/settings?owner=brian")).json()
    assert [row["id"] for row in listed["connections"]] == [hg.id]
    assert (await client.http.post("/app/widgets/settings", json={"operation": "mode", "id": bg.id, "mode": "projected"}, headers=HEADERS)).status == 404
    assert (await client.http.post("/app/widgets/settings", json={"operation": "revoke", "id": bg.id}, headers=HEADERS)).status == 200
    assert client.widgets.get_grant(brian) is not None
    response = await client.http.post("/app/widgets/settings", json={"operation": "mode", "id": hg.id, "mode": "projected"}, headers=HEADERS)
    assert response.status == 200
    assert (await (await read(client, hannah)).json())["mode"] == "projected"
    assert (await client.http.post("/app/widgets/settings", json={"operation": "revoke", "id": hg.id}, headers=HEADERS)).status == 200
    assert (await read(client, hannah)).status == 401
    assert (await read(client, brian)).status == 200


@pytest.mark.asyncio
async def test_read_only_token_cannot_authorize_phone_or_financial_mutations(client):
    token, _ = grant(client)
    headers = {**HEADERS, "Authorization": f"Bearer {token}"}
    for use_cookie in (False, True):
        if use_cookie:
            client.http.session.cookie_jar.update_cookies({"bb_phone_local": token})
        for method, url in (("GET", "/app/expenses/data"), ("GET", "/app/goals"), ("POST", "/app/goals"),
                            ("GET", "/app/reimbursements"), ("POST", "/app/reimbursements"),
                            ("GET", "/app/widgets/settings"), ("POST", "/app/widgets/settings"),
                            ("POST", "/app/notifications")):
            response = await client.http.request(method, url, headers=headers, json={"operation": "pair"})
            assert response.status == 401, (method, url)
        assert (await client.http.post("/app/widgets/data", headers=headers)).status == 405
    assert client.state.calls == []


@pytest.mark.asyncio
async def test_data_requires_bearer_not_cookie_pairing_or_query(client):
    phone_token = connect(client)
    token, _ = grant(client)
    pending = client.widgets.issue_pairing(BRIAN, "brian", "Other", "current")["pairingToken"]
    assert (await client.http.get("/app/widgets/data")).status == 401
    for candidate in ("", phone_token, pending, "bbw_read_bad", "bbw_read_" + "a" * 100):
        assert (await read(client, candidate)).status == 401
    for query in (f"?token={token}", "?owner=hannah", "?mode=projected", "?month=2025-01"):
        assert (await read(client, token, query)).status == 401
    assert client.state.calls == []


@pytest.mark.asyncio
async def test_canonical_fields_modes_and_owner_cache_isolation(client):
    brian, bg = grant(client)
    projected, _ = grant(client, mode="projected")
    hannah, _ = grant(client, HANNAH, "hannah")
    first = await read(client, brian)
    data = await first.json()
    assert data["budgetRemaining"] == 1234.56 and data["availableToday"] == 22.35
    assert data["ownerName"] == "Brian" and data["mode"] == "current" and data["todayState"] == "under"
    assert data["connectionId"] == bg.id and data["schemaVersion"] == 1
    assert data["updatedAt"] == client.state.now.astimezone(timezone.utc).isoformat()
    assert data["appUrl"] == ORIGIN + "/app/expenses" and data["avatarUrl"].startswith(ORIGIN + "/app/avatar.png?day=")
    assert first.headers["Cache-Control"] == "private, no-store"
    assert set(data) == {"schemaVersion", "ownerName", "month", "asOfDate", "timezone", "updatedAt", "staleAfterSeconds", "refreshAfterSeconds", "status", "budgetRemaining", "availableToday", "todayState", "connectionId", "mode", "appUrl", "avatarUrl"}
    assert client.widgets.get_grant(brian).last_used_at is not None
    other = await (await read(client, projected)).json()
    assert other["budgetRemaining"] == 2345.67 and other["availableToday"] == -10.55
    assert other["updatedAt"] == data["updatedAt"]
    assert len(client.state.calls) == 1, "Both modes reuse one canonical source snapshot"
    assert (await (await read(client, hannah)).json())["ownerName"] == "Hannah"
    assert len(client.state.calls) == 2
    assert client.state.calls[0]["persons"] == ["Brian (BofA)"]
    assert client.state.calls[1]["persons"] == ["Hannah"]


@pytest.mark.asyncio
async def test_revoke_or_mode_change_during_source_read(client):
    token, connection = grant(client)
    def revoke(data):
        client.widgets.revoke("brian", connection.id)
        return data
    client.state.revise = revoke
    response = await read(client, token)
    assert response.status == 401 and "1234.56" not in await response.text()
    token, connection = grant(client)
    # Authentication is still checked when the previous source build is cached.
    client.widgets.revoke("brian", connection.id)
    assert (await read(client, token)).status == 401
    client.app[phone_widgets._WIDGET_SNAPSHOTS].saved.clear()
    token, connection = grant(client)
    def change(data):
        client.widgets.set_mode("brian", connection.id, "projected")
        return data
    client.state.revise = change
    assert (await (await read(client, token)).json())["budgetRemaining"] == 2345.67


@pytest.mark.asyncio
async def test_remapped_owner_fails_before_or_after_read(client, monkeypatch):
    token, _ = grant(client)
    original = phone_app._valid_owner
    def changed(_):
        raise ValueError("mapping changed")
    def change(data):
        monkeypatch.setattr(phone_app, "_valid_owner", changed)
        return data
    client.state.revise = change
    assert (await read(client, token)).status == 401
    assert (await read(client, token)).status == 401
    assert len(client.state.calls) == 1
    monkeypatch.setattr(phone_app, "_valid_owner", original)


@pytest.mark.asyncio
async def test_changed_person_scope_or_midnight_during_read_fails_closed(client, monkeypatch):
    token, _ = grant(client)
    original = phone_app._valid_owner
    def change(data):
        def changed(session):
            owner = original(session)
            return SimpleNamespace(name=owner.name, expense_persons=["Hannah"], budget_owner_key=owner.budget_owner_key)
        monkeypatch.setattr(phone_app, "_valid_owner", changed)
        return data
    client.state.revise = change
    response = await read(client, token)
    assert response.status == 401 and "budgetRemaining" not in await response.text()
    monkeypatch.setattr(phone_app, "_valid_owner", original)
    client.app[phone_widgets._WIDGET_SNAPSHOTS].saved.clear()
    client.state.now = datetime(2025, 12, 31, 23, 59, tzinfo=PACIFIC_TZ)
    def midnight(data):
        client.state.now += timedelta(minutes=2)
        return data
    client.state.revise = midnight
    assert (await read(client, token)).status == 503


@pytest.mark.asyncio
async def test_session_revoked_while_creating_pairing_cleans_up(client, monkeypatch):
    connect(client)
    original = client.widgets.issue_pairing
    def issue(*args):
        value = original(*args)
        client.access.revoke_owner("brian")
        return value
    monkeypatch.setattr(client.widgets, "issue_pairing", issue)
    result = await client.http.post("/app/widgets/settings", json={"operation": "pair", "label": "Phone", "mode": "current"}, headers=HEADERS)
    assert result.status == 401 and "bbw_pair_" not in await result.text()
    assert client.widgets.list_connections("brian")["connections"] == []


@pytest.mark.asyncio
async def test_reset_revokes_just_that_owners_widgets_and_phone_access(client):
    connect(client)
    brian, _ = grant(client)
    hannah, _ = grant(client, HANNAH, "hannah")
    phone_app.reset_phone_access(BRIAN)
    assert (await client.http.get("/app/widgets/settings")).status == 401
    assert (await read(client, brian)).status == 401
    assert (await read(client, hannah)).status == 200


@pytest.mark.asyncio
async def test_signout_preserves_separate_widget_connection(client):
    connect(client)
    token, _ = grant(client)
    assert (await client.http.post("/app/logout", headers=HEADERS)).status == 204
    assert (await client.http.get("/app/widgets/settings")).status == 401
    assert (await read(client, token)).status == 200


@pytest.mark.asyncio
async def test_delayed_shared_build_recovers_without_new_read_or_fresh_timestamp(client, monkeypatch):
    token, _ = grant(client)
    began, release = Event(), Event()
    def delayed(data):
        began.set()
        assert release.wait(3)
        return data
    client.state.revise = delayed
    monkeypatch.setattr(phone_widgets, "_READ_TIMEOUT", 0.03)
    try:
        responses = await asyncio.gather(*(read(client, token) for _ in range(3)))
        assert began.is_set()
        assert all(response.status == 503 for response in responses)
        assert all(response.headers["Retry-After"] == "60" for response in responses)
        assert len(client.state.calls) == 1
        assert len(client.app[phone_widgets._WIDGET_SNAPSHOTS].tasks) == 1
    finally:
        release.set()
    await asyncio.gather(*client.app[phone_widgets._WIDGET_SNAPSHOTS].tasks.values())
    result = await (await read(client, token)).json()
    assert result["updatedAt"] == client.state.now.astimezone(timezone.utc).isoformat()
    assert len(client.state.calls) == 1


@pytest.mark.asyncio
async def test_cache_expires_without_sliding_and_failure_never_returns_fake_fresh(client):
    token, _ = grant(client)
    first = await (await read(client, token)).json()
    snapshots = client.app[phone_widgets._WIDGET_SNAPSHOTS]
    key = next(iter(snapshots.saved))
    cached_time, value = snapshots.saved[key]
    await read(client, token)
    assert snapshots.saved[key][0] == cached_time
    snapshots.saved[key] = (cached_time - 301, value)
    def unavailable(_):
        raise TimeoutError("source unavailable")
    client.state.revise = unavailable
    failed = await read(client, token)
    assert failed.status == 503 and "budgetRemaining" not in await failed.text()
    client.state.revise = None
    recovered = await (await read(client, token)).json()
    assert recovered["budgetRemaining"] == first["budgetRemaining"]
    assert len(client.state.calls) == 3


@pytest.mark.asyncio
async def test_current_pacific_date_and_month_roll_over(client):
    token, _ = grant(client)
    client.state.now = datetime(2025, 12, 31, 23, 59, tzinfo=PACIFIC_TZ)
    december = await (await read(client, token)).json()
    client.state.now += timedelta(minutes=2)
    january = await (await read(client, token)).json()
    assert december["month"] == "2025-12" and january["month"] == "2026-01"
    assert january["asOfDate"] == "2026-01-01"
    assert len(client.state.calls) == 2


@pytest.mark.asyncio
@pytest.mark.parametrize("burn", [None, {"status": "not_started", "totalDifference": 100}])
async def test_unavailable_today_does_not_invent_zero(client, burn):
    token, _ = grant(client)
    def change(data):
        data["modeViews"]["current"]["burnRate"] = burn
        data["modeViews"]["current"]["metrics"]["incomeAfterExpenses"] = None
        return data
    client.state.revise = change
    result = await (await read(client, token)).json()
    assert result["availableToday"] is None and result["budgetRemaining"] is None
    assert result["todayState"] == ("not_started" if burn else "unavailable")


@pytest.mark.asyncio
@pytest.mark.parametrize("fault", ["nan", "owner", "date", "missing"])
async def test_incomplete_or_mismatched_snapshot_fails_closed(client, fault):
    token, _ = grant(client)
    def change(data):
        if fault == "nan": data["modeViews"]["current"]["metrics"]["incomeAfterExpenses"] = float("nan")
        elif fault == "owner": data["ownerName"] = "Hannah"
        elif fault == "date": data["generatedAtIso"] = "invalid"
        else: data.pop("modeViews")
        return data
    client.state.revise = change
    result = await read(client, token)
    assert result.status == 503 and "budgetRemaining" not in await result.text()


@pytest.mark.asyncio
async def test_validation_limits_and_errors_do_not_echo_secrets(client, monkeypatch, caplog):
    connect(client)
    for body in ({"operation": "pair", "label": "Phone", "mode": "current", "owner": "hannah"},
                 {"operation": "pair", "label": "Phone", "mode": "invalid"}, [1, 2]):
        assert (await client.http.post("/app/widgets/settings", json=body, headers=HEADERS)).status == 400
    async def chunks():
        yield b" " * 1200
        yield b" " * 1200
    assert (await client.http.post("/app/widgets/pair", data=chunks())).status == 400
    assert (await client.http.post("/app/widgets/pair", json={"pairingToken": "bad", "owner": "hannah"})).status == 400
    for index in range(5): client.widgets.issue_pairing(BRIAN, "brian", str(index), "current")
    result = await client.http.post("/app/widgets/settings", json={"operation": "pair", "label": "Six", "mode": "current"}, headers=HEADERS)
    assert result.status == 409
    def fail(*_): raise RuntimeError("SQL secret=bbw_read_private_credential")
    monkeypatch.setattr(client.widgets, "list_connections", fail)
    result = await client.http.get("/app/widgets/settings")
    assert result.status == 503
    assert "private_credential" not in (await result.text()) + caplog.text


@pytest.mark.asyncio
async def test_script_and_help_are_public_but_never_authenticated_links(client):
    response = await client.http.get("/app/widgets/script")
    assert response.status == 200
    text = await response.text()
    assert f'const BOOKIEBOT_ORIGIN = "{ORIGIN}";' in text
    assert "__BOOKIEBOT_ORIGIN__" not in text
    assert response.headers["Content-Disposition"] == 'attachment; filename="BookieBot.js"'
    assert response.headers["Cache-Control"] == "private, no-store"
    help_page = await (await client.http.get("/app/widgets/help")).text()
    assert "browser" in help_page and "15 minutes" in help_page
    assert "iOS chooses refresh timing" in help_page


@pytest.mark.asyncio
@pytest.mark.parametrize("path", ["/app/widgets/help", "/app/widgets/connect"])
async def test_widget_setup_pages_return_to_settings_without_pairing_or_exposing_secrets(client, path):
    issued = client.widgets.issue_pairing(BRIAN, "brian", "Phone", "current")
    response = await client.http.get(path)
    page = await response.text()
    assert response.status == 200 and not response.cookies
    assert response.headers["Cache-Control"] == "private, no-store"
    assert response.headers["Referrer-Policy"] == "no-referrer"
    assert page.count('← Back to Settings</a>') == 2
    assert 'href="/app/expenses#settings"' in page
    assert "Back to Settings" in page and "does not pair the widget" in page
    assert "inside the Scriptable app" in page and "Pair this phone" in page
    assert 'href="https://apps.apple.com/app/scriptable/id1405459188" target="_blank" rel="noreferrer"' in page
    assert "Copy script" in page
    assert 'href="/app/widgets/script"' not in page and f'href="{ORIGIN}/app/widgets/script"' not in page
    assert "bbw_pair_" not in page and "bbw_read_" not in page
    assert issued["pairingToken"] not in page
    assert client.widgets.list_connections("brian")["connections"][0]["status"] == "pending"


def test_widget_values_match_real_canonical_report_modes(monkeypatch):
    from bookiebot.reports import expense_breakdown as reports
    from unit_tests.support.sheets_repo_stub import InMemoryWorksheet
    now = datetime(2026, 7, 5, 12, tzinfo=PACIFIC_TZ)
    monkeypatch.setattr(reports, "now_pacific", lambda: now)
    report = reports.build_expense_breakdown_report(
        actor_key="hannah", owner_name="Hannah", persons=["Hannah"], month=reports.BudgetMonth(2026, 7),
        worksheets=reports.ReportWorksheets(
            shared_expenses=InMemoryWorksheet([["hdr"] * 28, ["hdr"] * 28]),
            personal_budget=InMemoryWorksheet([["Main Income Source", "Paycheck"], ["Biweekly Income Start", "7/2/2026"],
                                              ["Paycheck", "$2,000.00"], ["Rent", "$1,750.00"], ["PG&E", "$140.00"]]),
            subscriptions=InMemoryWorksheet([])))
    data = reports.expense_breakdown_client_payload(report)
    snapshot = phone_widgets._snapshot(data, {"owner_name": "Hannah", "year": 2026, "month": 7}, "2026-07-05")
    assert snapshot["updatedAt"] == now.astimezone(timezone.utc).isoformat()
    for mode in ("current", "projected"):
        canonical = reports.expense_breakdown_mode_view(report, mode)
        assert snapshot["views"][mode]["budgetRemaining"] == canonical["metrics"]["incomeAfterExpenses"]
        assert snapshot["views"][mode]["availableToday"] == -canonical["burnRate"]["totalDifference"]
    assert snapshot["views"]["current"]["budgetRemaining"] != snapshot["views"]["projected"]["budgetRemaining"]
