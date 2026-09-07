from types import SimpleNamespace
from uuid import uuid4

from aiohttp import web, CookieJar
from aiohttp.test_utils import TestClient, TestServer
import pytest
import pytest_asyncio

from bookiebot.reports import phone_app, phone_goals
from bookiebot.reports.app_access import AppAccessStore
from bookiebot.reports.goals_store import GoalsStore

BRIAN = "676638528590970917"
HANNAH = "830984827904851969"
HEADERS = {"X-BookieBot-App": "1", "Origin": "http://127.0.0.1"}


@pytest_asyncio.fixture
async def client(tmp_path, monkeypatch):
    monkeypatch.setenv("BOOKIEBOT_PUBLIC_BASE_URL", "http://127.0.0.1")
    access = AppAccessStore(tmp_path / "access.sqlite3")
    access.initialize()
    goals = GoalsStore(access)
    goals.initialize()
    monkeypatch.setattr(phone_app, "build_app_access_store", lambda: access)
    monkeypatch.setattr(phone_goals, "build_goals_store", lambda: goals)
    app = web.Application()
    phone_goals.register_phone_goal_routes(app)
    async with TestClient(TestServer(app), cookie_jar=CookieJar(unsafe=True)) as http:
        yield SimpleNamespace(http=http, access=access, goals=goals)


def connect(client, actor=BRIAN, owner="brian"):
    paired = client.access.consume_pairing(client.access.issue_pairing(actor, owner))
    assert paired is not None
    client.http.session.cookie_jar.update_cookies({"bb_phone_local": paired[0]})


def create_body():
    return {"operation": "create", "requestId": uuid4().hex, "name": "Trip", "targetCents": 300_000, "startingCents": 0}


@pytest.mark.asyncio
async def test_goals_require_auth_and_ignore_query_identity(client):
    assert (await client.http.get("/app/goals")).status == 401
    connect(client)
    response = await client.http.post("/app/goals", json=create_body(), headers=HEADERS)
    assert response.status == 200
    assert response.headers["Cache-Control"] == "private, no-store"
    goal = (await response.json())["goal"]
    result = await client.http.get("/app/goals?owner=hannah")
    assert (await result.json())["goals"][0]["id"] == goal["id"]
    connect(client, HANNAH, "hannah")
    assert (await (await client.http.get("/app/goals")).json())["goals"] == []
    assert (await client.http.get(f"/app/goals/{goal['id']}/contributions")).status == 404
    assert (await client.http.post("/app/goals", json={"operation": "archive", "requestId": uuid4().hex,
                                                     "goalId": goal["id"], "version": goal["version"]}, headers=HEADERS)).status == 404


@pytest.mark.asyncio
@pytest.mark.parametrize("headers", [{}, {**HEADERS, "Origin": "https://attacker.test"}, {**HEADERS, "Sec-Fetch-Site": "cross-site"}])
async def test_cross_site_mutations_have_no_effect(client, headers):
    connect(client)
    assert (await client.http.post("/app/goals", json=create_body(), headers=headers)).status == 403
    assert client.goals.list_goals("brian")["goals"] == []


@pytest.mark.asyncio
async def test_request_validation_and_stale_update(client):
    connect(client)
    for body in ({**create_body(), "owner_key": "hannah"}, [1, 2], {**create_body(), "targetCents": -1}):
        assert (await client.http.post("/app/goals", json=body, headers=HEADERS)).status == 400
    assert (await client.http.post("/app/goals", data="x" * 5000, headers=HEADERS)).status == 400
    response = await client.http.post("/app/goals", json=create_body(), headers=HEADERS)
    goal = (await response.json())["goal"]
    assert (await client.http.post("/app/goals", json={"operation": "archive", "requestId": uuid4().hex,
                                                     "goalId": goal["id"], "version": 0}, headers=HEADERS)).status == 409
    assert (await client.http.get(f"/app/goals/{goal['id']}/contributions?offset=bad")).status == 400


@pytest.mark.asyncio
async def test_revoked_session_during_read_drops_personal_goal_data(client, monkeypatch):
    connect(client)
    client.goals.command("brian", create_body())
    original = client.goals.list_goals
    def revoke_during_read(owner):
        data = original(owner)
        client.access.revoke_owner(owner)
        return data
    monkeypatch.setattr(client.goals, "list_goals", revoke_during_read)
    result = await client.http.get("/app/goals")
    assert result.status == 401
    assert "Trip" not in await result.text()
