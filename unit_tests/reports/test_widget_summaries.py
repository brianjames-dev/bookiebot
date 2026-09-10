import asyncio
from datetime import date, datetime, timezone
from threading import Event

import pytest

from bookiebot.reports import phone_widgets, widget_summaries
from unit_tests.reports.test_phone_widgets import HANNAH, client, grant, read


def report_sections(report):
    for mode, view in report["modeViews"].items():
        view.update(categoryBalances={"remaining": {"needs": 33.33 if mode == "current" else 81.25, "wants": -5.55}},
                    categoryBudgets={"needs": 100 if mode == "current" else 200, "wants": 50},
                    calendarEvents=[{"kind": "subscription", "label": "Internet", "amount": 65,
                                     "day": datetime.fromisoformat(report["generatedAtIso"]).day, "projectedOnly": True}])
    return report


def test_upcoming_calendar_is_bounded_sorted_and_never_claims_payment_status():
    events = [
        {"kind": "income", "label": "Payday", "amount": 4000, "day": 12},
        {"kind": "bill", "label": "Earlier", "amount": 90, "day": 8},
        {"kind": "subscription", "label": "Later", "amount": 20, "day": 29},
        {"kind": "subscription", "label": "Today", "amount": 65, "day": 9, "projectedOnly": False},
        {"kind": "bill", "label": "Scheduled bill", "amount": 124, "day": 18, "projectedOnly": True},
        {"kind": "subscription", "label": "Free plan", "amount": 0, "day": 10},
    ]
    report = {"modeViews": {"current": {"calendarEvents": events}}}
    result = widget_summaries.report_content(report, "upcoming", "current", "2026-09-09")
    assert result == {"payments": [{"label": "Today", "amount": 65, "date": "2026-09-09", "kind": "subscription"},
                                   {"label": "Scheduled bill", "amount": 124, "date": "2026-09-18", "kind": "bill"}],
                      "totalCount": 3, "windowEnd": "2026-09-30"}
    assert widget_summaries.report_content(report, "upcoming", "current", "2026-09-30")["payments"] == []
    events.append({"kind": "bill", "label": "Invalid date", "amount": 1, "day": 31})
    with pytest.raises(ValueError):
        widget_summaries.report_content(report, "upcoming", "current", "2026-09-09")


def test_category_values_are_canonical_even_with_cascade_and_deficit():
    report = {"modeViews": {"projected": {"categoryBalances": {"remaining": {"needs": 33.33, "wants": -5.55}},
                                             "categoryBudgets": {"needs": 100, "wants": 0}}}}
    assert widget_summaries.report_content(report, "categories", "projected", "2026-09-09") == {
        "needs": {"remaining": 33.33, "budget": 100}, "wants": {"remaining": -5.55, "budget": 0}}
    report["modeViews"]["projected"]["categoryBalances"]["remaining"]["needs"] = float("nan")
    with pytest.raises(ValueError):
        widget_summaries.report_content(report, "categories", "projected", "2026-09-09")


@pytest.mark.asyncio
async def test_report_types_share_source_and_mode_but_only_expose_requested_summary(client):
    client.state.revise = report_sections
    current, _ = grant(client)
    projected, _ = grant(client, mode="projected")
    budget = await (await read(client, current)).json()
    categories = await (await read(client, current, "/categories")).json()
    forecast = await (await read(client, projected, "/categories")).json()
    upcoming = await (await read(client, current, "/upcoming")).json()
    assert categories["content"]["needs"] == {"remaining": 33.33, "budget": 100}
    assert forecast["content"]["needs"] == {"remaining": 81.25, "budget": 200}
    assert categories["schemaVersion"] == 2 and upcoming["type"] == "upcoming"
    assert categories["updatedAt"] == budget["updatedAt"] == upcoming["updatedAt"]
    assert "content" not in budget and "summaries" not in budget
    assert "budgetRemaining" not in categories and "privateItems" not in str(categories)
    assert len(client.state.calls) == 1


@pytest.mark.asyncio
async def test_missing_optional_report_section_is_not_zero_or_connected_and_budget_still_works(client):
    token, _ = grant(client)
    assert (await read(client, token, "/categories")).status == 503
    assert client.widgets.get_grant(token).last_used_at is None
    assert (await read(client, token)).status == 200
    assert len(client.state.calls) == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("kind", ["upcoming", "categories", "savings", "shared"])
async def test_typed_routes_do_not_accept_cookie_or_query_authority(client, kind):
    token, _ = grant(client)
    assert (await client.http.get("/app/widgets/data/" + kind)).status == 401
    for query in ("?owner=hannah", "?mode=projected", "?month=2025-01", "?token=" + token):
        assert (await read(client, token, "/" + kind + query)).status == 401
    assert (await client.http.post("/app/widgets/data/" + kind, headers={"Authorization": "Bearer " + token})).status == 405
    assert client.state.calls == []


@pytest.mark.asyncio
async def test_invalid_goal_selector_never_revokes_or_reads(client):
    token, _ = grant(client)
    for value in ("", "../../hannah", "a" * 33, "not-a-goal"):
        assert (await read(client, token, "/savings?goalId=" + value)).status == 400
    assert (await read(client, token, "/savings?goalId=" + "a" * 32 + "&goalId=" + "b" * 32)).status == 401
    assert client.widgets.get_grant(token) is not None
    assert client.state.calls == []


def database_result(kind, payload, day):
    content = {"goals": [{"id": "a" * 32, "name": "Trip", "balance": 100, "target": 200,
                          "remaining": 100, "progress": .5}]} if kind == "savings" else {
        "owedToYou": 10, "youOwe": 5, "partnerName": "Hannah" if payload["owner_key"] == "brian" else "Brian",
        "pendingCount": 0, "projectionPending": False}
    return {"schemaVersion": 2, "type": kind, "ownerName": payload["owner_name"], "month": day[:7], "asOfDate": day,
            "timezone": "America/Los_Angeles", "updatedAt": datetime.now(timezone.utc).isoformat(),
            "staleAfterSeconds": 1800, "refreshAfterSeconds": 900, "status": "fresh", "content": content}


@pytest.mark.asyncio
async def test_database_types_have_separate_owner_caches_and_never_call_sheets(client, monkeypatch):
    calls = []
    def build(kind, payload, day):
        calls.append((kind, payload["owner_key"]))
        return database_result(kind, payload, day)
    monkeypatch.setattr(phone_widgets, "database_snapshot", build)
    brian, _ = grant(client)
    hannah, _ = grant(client, HANNAH, "hannah")
    first = await (await read(client, brian, "/savings")).json()
    foreign = await (await read(client, brian, "/savings?goalId=" + "b" * 32)).json()
    assert foreign["content"]["goal"] is None and foreign["content"]["emptyReason"] == "goal_unavailable"
    assert "balance" not in str(foreign["content"]["goals"])
    assert (await read(client, brian, "/shared")).status == 200
    assert (await read(client, hannah, "/shared")).status == 200
    again = await (await read(client, brian, "/savings?goalId=" + "a" * 32)).json()
    assert first["updatedAt"] == again["updatedAt"]
    assert calls == [("savings", "brian"), ("shared", "brian"), ("shared", "hannah")]
    assert client.state.calls == []


@pytest.mark.asyncio
async def test_revoke_during_database_read_is_rechecked(client, monkeypatch):
    token, connection = grant(client)
    def build(kind, payload, day):
        client.widgets.revoke("brian", connection.id)
        return database_result(kind, payload, day)
    monkeypatch.setattr(phone_widgets, "database_snapshot", build)
    response = await read(client, token, "/savings")
    assert response.status == 401 and "Trip" not in await response.text()


@pytest.mark.asyncio
async def test_timed_out_database_read_stays_coalesced_and_keeps_source_time(client, monkeypatch):
    token, _ = grant(client)
    started, release = Event(), Event()
    generated = []
    def build(kind, payload, day):
        data = database_result(kind, payload, day)
        generated.append(data["updatedAt"])
        started.set()
        release.wait(2)
        return data
    monkeypatch.setattr(phone_widgets, "database_snapshot", build)
    monkeypatch.setattr(phone_widgets, "_READ_TIMEOUT", .02)
    try:
        assert (await read(client, token, "/savings")).status == 503
        assert started.is_set()
        assert (await read(client, token, "/savings")).status == 503
        assert len(generated) == 1
    finally:
        release.set()
    await asyncio.gather(*client.app[phone_widgets._WIDGET_DATABASE_SNAPSHOTS]["savings"].tasks.values())
    result = await (await read(client, token, "/savings")).json()
    assert result["updatedAt"] == generated[0]


def test_shared_summary_does_not_project_or_apply_pending_payments(monkeypatch):
    monkeypatch.setattr(widget_summaries.reimbursements, "enabled", lambda: True)
    row = {"id": "split", "payerOwner": "brian", "partnerOwner": "hannah", "partnerShareCents": 5000,
           "settledCents": 1000, "outstandingCents": 4000}
    def snapshot(owner, *, retry_projection):
        assert owner == "brian" and retry_projection is False
        return {"ownerKey": owner, "currency": "USD", "allocations": [row], "projectionPending": True,
                "events": [{"allocationId": "split", "status": "pending", "amountCents": 2000}]}
    monkeypatch.setattr(widget_summaries.reimbursements, "snapshot", snapshot)
    assert widget_summaries._shared_content("brian") == {"owedToYou": 40, "youOwe": 0, "partnerName": "Hannah",
                                                       "pendingCount": 1, "projectionPending": True}
    row["partnerOwner"] = "brian"
    with pytest.raises(ValueError):
        widget_summaries._shared_content("brian")


def test_unavailable_shared_feature_is_not_an_empty_balance(monkeypatch):
    monkeypatch.setattr(widget_summaries.reimbursements, "enabled", lambda: False)
    with pytest.raises(ValueError):
        widget_summaries._shared_content("brian")
