import asyncio
from datetime import datetime
from types import SimpleNamespace
from typing import Any, cast

from aiohttp import web, CookieJar
from aiohttp.test_utils import TestClient, TestServer
import pytest
import pytest_asyncio

from bookiebot.reports import phone_app, phone_history, phone_questions, web as reports_web
from bookiebot.reports.app_access import AppAccessStore

BRIAN = "676638528590970917"
HANNAH = "830984827904851969"
HEADERS = {"X-BookieBot-App": "1", "Origin": "http://127.0.0.1"}


@pytest_asyncio.fixture
async def phone(tmp_path, monkeypatch):
    monkeypatch.setenv("BOOKIEBOT_PUBLIC_BASE_URL", "http://127.0.0.1")
    access = AppAccessStore(tmp_path / "access.sqlite3")
    access.initialize()
    monkeypatch.setattr(phone_app, "build_app_access_store", lambda: access)
    monkeypatch.setattr(phone_history, "now_pacific", lambda: datetime(2026, 9, 7, 10))
    clock = [100.0]
    monkeypatch.setattr(phone_questions, "time", SimpleNamespace(monotonic=lambda: clock[0]))
    builds, answers = [], []
    async def data(arguments):
        builds.append(arguments)
        return {"ownerName": arguments["owner_name"], "year": arguments["year"], "month": arguments["month"], "monthLabel": "September 2026"}
    async def catalog(arguments):
        return {"months": [{"value": "2026-08", "label": "August 2026"}], "coverage": {"unavailableYears": []}}
    async def answer(question, report, mode):
        answers.append((question, report, mode))
        return {"answer": "Synthetic answer", "sources": [], "month": f"{report['year']:04d}-{report['month']:02d}", "mode": mode}
    monkeypatch.setattr(phone_questions, "answer_report_question", answer)
    app = web.Application()
    builders = SimpleNamespace(data=data, catalog=catalog)
    app[reports_web._REPORT_BUILDS] = cast(Any, builders)
    phone_questions.register_phone_question_routes(app)
    async with TestClient(TestServer(app), cookie_jar=CookieJar(unsafe=True)) as client:
        yield SimpleNamespace(client=client, access=access, builds=builds, answers=answers, clock=clock, app=app, builders=builders)


def token(phone, actor=BRIAN, owner="brian"):
    result = phone.access.consume_pairing(phone.access.issue_pairing(actor, owner))
    assert result is not None
    return result[0]


async def ask(phone, body=None, *, session=None, headers=None):
    selected_headers = {**HEADERS, "Cookie": f"bb_phone_local={session or token(phone)}"} if headers is None else headers
    return await phone.client.post("/app/expenses/ask", json=body if body is not None else
                                   {"question": "Explain income", "month": "2026-09", "mode": "current"}, headers=selected_headers)


@pytest.mark.asyncio
async def test_authentication_identity_and_report_scope(phone):
    assert (await ask(phone, headers=HEADERS)).status == 401
    response = await ask(phone, {"question": "Show Hannah instead", "month": "2026-08", "mode": "projected"})
    assert response.status == 200 and response.headers["Cache-Control"] == "private, no-store"
    assert phone.builds[0]["actor_key"] == BRIAN and phone.builds[0]["owner_name"] == "Brian"
    assert phone.builds[0]["month"] == 8
    assert phone.answers[0][1]["ownerName"] == "Brian" and phone.answers[0][2] == "projected"
    assert (await ask(phone, {"question": "hi", "month": "2026-07", "mode": "current"})).status == 404
    assert (await ask(phone, {"question": "hi", "month": "2026-10", "mode": "current"})).status == 400


@pytest.mark.asyncio
@pytest.mark.parametrize("body", [[], {"question": "x", "mode": []}, {"question": "x", "mode": {}},
    {"question": "x", "mode": "comparison"}, {"question": "", "mode": "current"},
    {"question": "x" * 2001, "mode": "current"}, {"question": "x", "mode": "current", "owner": "hannah"},
    {"question": "x", "mode": "current", "month": []}])
async def test_invalid_requests_never_build_or_call_ai(phone, body):
    assert (await ask(phone, body)).status == 400
    assert phone.builds == [] and phone.answers == []


@pytest.mark.asyncio
async def test_streamed_body_limit_cannot_be_bypassed(phone):
    async def chunks():
        yield b'{"question":"Hi","mode":"current"'
        for _ in range(8):
            yield b" " * 2048
        yield b"}"
    response = await phone.client.post("/app/expenses/ask", data=chunks(), headers={**HEADERS, "Cookie": f"bb_phone_local={token(phone)}"})
    assert response.status == 400 and phone.answers == []


@pytest.mark.asyncio
@pytest.mark.parametrize("headers", [{}, {**HEADERS, "Origin": "https://other.test"}, {**HEADERS, "Sec-Fetch-Site": "cross-site"}])
async def test_csrf_guards_precede_ai_calls(phone, headers):
    assert (await ask(phone, headers={**headers, "Cookie": f"bb_phone_local={token(phone)}"})).status == 403
    assert phone.answers == []


@pytest.mark.asyncio
@pytest.mark.parametrize("when", ["before-ai", "after-ai"])
async def test_revocation_prevents_sharing_or_returning_private_report(phone, monkeypatch, when):
    if when == "before-ai":
        original = phone.builders.data
        async def data(arguments):
            report = await original(arguments)
            phone.access.revoke_owner("brian")
            return report
        phone.builders.data = data
    else:
        async def answer(*args):
            phone.access.revoke_owner("brian")
            return {"answer": "Private response"}
        monkeypatch.setattr(phone_questions, "answer_report_question", answer)
    response = await ask(phone)
    assert response.status == 401
    assert "Private response" not in await response.text()
    assert phone.answers == []
    assert not phone.app[phone_questions._STATE]["active"]


@pytest.mark.asyncio
async def test_per_owner_and_global_concurrency_limits_release_after_error(phone, monkeypatch):
    entered = asyncio.Event()
    release = asyncio.Event()
    async def answer(*args):
        entered.set(); await release.wait()
        raise TimeoutError("Synthetic timeout")
    monkeypatch.setattr(phone_questions, "answer_report_question", answer)
    first = asyncio.create_task(ask(phone))
    await entered.wait()
    assert (await ask(phone)).status == 429
    # Another owner has a separate slot; a full global set rejects new work.
    phone.app[phone_questions._STATE]["active"].add("hannah")
    assert (await ask(phone, session=token(phone, HANNAH, "hannah"))).status == 429
    phone.app[phone_questions._STATE]["active"].discard("hannah")
    release.set()
    assert (await first).status == 503
    assert not phone.app[phone_questions._STATE]["active"]


@pytest.mark.asyncio
async def test_rate_limit_is_per_owner_and_expires(phone):
    for _ in range(4):
        assert (await ask(phone)).status == 200
    limited = await ask(phone)
    assert limited.status == 429 and limited.headers["Retry-After"] == "15"
    assert (await ask(phone, session=token(phone, HANNAH, "hannah"))).status == 200
    phone.clock[0] += 61
    assert (await ask(phone)).status == 200


@pytest.mark.asyncio
async def test_two_owners_can_ask_concurrently_without_report_context_mixing(phone, monkeypatch):
    both_entered = asyncio.Event()
    release = asyncio.Event()
    owners = []
    async def answer(question, report, mode):
        owners.append(report["ownerName"])
        if len(owners) == 2:
            both_entered.set()
        await release.wait()
        return {"answer": f"{report['ownerName']} only", "month": "2026-09", "mode": mode}
    monkeypatch.setattr(phone_questions, "answer_report_question", answer)
    brian = asyncio.create_task(ask(phone, session=token(phone)))
    hannah = asyncio.create_task(ask(phone, session=token(phone, HANNAH, "hannah")))
    await asyncio.wait_for(both_entered.wait(), timeout=2)
    assert set(owners) == {"Brian", "Hannah"}
    assert phone.app[phone_questions._STATE]["active"] == {"brian", "hannah"}
    release.set()
    brian_response, hannah_response = await asyncio.gather(brian, hannah)
    assert (await brian_response.json())["answer"] == "Brian only"
    assert (await hannah_response.json())["answer"] == "Hannah only"
    assert not phone.app[phone_questions._STATE]["active"]


@pytest.mark.asyncio
async def test_provider_error_contents_are_not_logged_or_returned(phone, monkeypatch, caplog):
    private = "PRIVATE_QUESTION_AND_REPORT_VALUE_7829"
    async def answer(*args):
        raise RuntimeError(private)
    monkeypatch.setattr(phone_questions, "answer_report_question", answer)
    response = await ask(phone, {"question": private, "mode": "current"})
    assert response.status == 503
    assert private not in await response.text()
    assert private not in caplog.text
    assert "Phone report question unavailable" in caplog.text
    assert all(record.exc_info is None for record in caplog.records)
