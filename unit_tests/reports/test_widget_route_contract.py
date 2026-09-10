"""Real Python producers and the delivered Scriptable consumer share one contract."""
import asyncio
import calendar
import json
from pathlib import Path
import shutil
from uuid import uuid4

import pytest

from unit_tests.reports.test_phone_widgets import (
    BRIAN, HANNAH, HEADERS, ORIGIN, client, connect,
)
from bookiebot.reports import goals_store, widget_summaries
from bookiebot.reimbursements import service as reimbursement_service, store as reimbursement_store, projection
from unit_tests.reimbursements.test_store import payload as allocation_payload, payment


def typed_sources(client, monkeypatch, owner, mode):
    """Canonical report fields plus real owner-scoped database records."""
    today = client.state.now.date()
    month_end = today.replace(day=calendar.monthrange(today.year, today.month)[1])
    electric_label = "Electric " + "scheduled account " * 5

    def enrich(report):
        for key, view in report["modeViews"].items():
            view["categoryBudgets"] = {"needs": 500 if key == "current" else 750, "wants": 300 if key == "current" else 450, "savings": 200}
            view["categoryBalances"] = {
                "remaining": {"needs": 0 if key == "current" else 100, "wants": 50 if key == "current" else 125, "savings": 150},
                "raw": {"needs": -100, "wants": 150, "savings": 150},
                "transfers": [{"from": "wants", "to": "needs", "amount": 100}],
            }
            view["calendarEvents"] = [
                {"kind": "bill", "label": electric_label, "amount": 86.5, "day": today.day, "group": "bills_utilities", "projectedOnly": True},
                {"kind": "subscription", "label": "Streaming", "amount": 12, "day": today.day, "group": "wants", "projectedOnly": True},
                {"kind": "bill", "label": "Insurance", "amount": 45, "day": today.day, "group": "bills_utilities", "projectedOnly": True},
                {"kind": "income", "label": "Private income", "amount": 99999, "day": today.day, "group": "income", "projectedOnly": True},
            ]
            if today.day > 1:
                view["calendarEvents"].append({"kind": "bill", "label": "Past payment", "amount": 777, "day": today.day - 1, "group": "bills_utilities", "projectedOnly": False})
        return report

    client.state.revise = enrich
    goals = goals_store.GoalsStore(client.access)
    goals.initialize()
    monkeypatch.setattr(goals_store, "build_goals_store", lambda: goals)
    monkeypatch.setattr(widget_summaries, "build_goals_store", lambda: goals)

    def create_goal(account, name, balance):
        return goals.command(account, {"operation": "create", "requestId": uuid4().hex, "name": name,
            "targetCents": 100_000, "startingCents": balance, "targetDate": ""})["goal"]

    first = create_goal(owner, "Emergency fund", 25_000)
    second = create_goal(owner, "Holiday", 35_000)
    archived = create_goal(owner, "Archived goal", 90_000)
    goals.command(owner, {"operation": "archive", "requestId": uuid4().hex, "goalId": archived["id"], "version": archived["version"]})
    partner = "hannah" if owner == "brian" else "brian"
    foreign = create_goal(partner, "Private partner goal", 98_765)

    ledger = reimbursement_store.ReimbursementStore(client.access)
    ledger.initialize()
    monkeypatch.setattr(reimbursement_service, "enabled", lambda: True)
    monkeypatch.setattr(reimbursement_service, "build_reimbursement_store", lambda: ledger)
    monkeypatch.setattr(reimbursement_store, "build_reimbursement_store", lambda: ledger)
    incoming = ledger.register_allocation(allocation_payload(payerOwner=owner, partnerOwner=partner, payerPerson=owner.title()))
    ledger.register_allocation(allocation_payload(payerOwner=partner, partnerOwner=owner, payerPerson=partner.title(),
        payerShareCents=7500, partnerShareCents=2500))
    ledger.command(partner, payment(incoming, amount=1000, operation="report_payment"))

    def reject_projection(*_args, **_kwargs):
        raise AssertionError("Read-only widget requests must never project reimbursement rows into sheets")

    monkeypatch.setattr(projection, "sync_pending", reject_projection)
    before_ledger = ledger.snapshot(owner)
    before_goals = goals.list_goals(owner)
    content = {
        "categories": {"needs": {"remaining": 0 if mode == "current" else 100, "budget": 500 if mode == "current" else 750},
                       "wants": {"remaining": 50 if mode == "current" else 125, "budget": 300 if mode == "current" else 450}},
        "upcoming": {"totalCount": 3, "windowEnd": month_end.isoformat(), "today": today.isoformat(),
                     "labels": [electric_label, "Streaming", "Insurance"]},
        "shared": {"owedToYou": 40, "youOwe": 25, "partnerName": partner.title(), "pendingCount": 1, "projectionPending": True},
        "goals": [{"id": first["id"], "name": first["name"], "balance": 250, "target": 1000, "remaining": 750, "progress": 0.25},
                  {"id": second["id"], "name": second["name"], "balance": 350, "target": 1000, "remaining": 650, "progress": 0.35}],
        "unavailableGoals": [archived["id"], foreign["id"]],
    }
    return content, lambda: (ledger.snapshot(owner) == before_ledger and goals.list_goals(owner) == before_goals)


@pytest.mark.asyncio
@pytest.mark.parametrize("actor,owner,name", [(BRIAN, "brian", "Brian"), (HANNAH, "hannah", "Hannah")])
@pytest.mark.parametrize("mode", ["current", "projected"])
async def test_actual_widget_routes_accept_distributed_script_requests(client, tmp_path, monkeypatch, actor, owner, name, mode):
    node = shutil.which("node")
    if not node:
        pytest.skip("Node is required for the Scriptable route contract")
    typed, financial_state_unchanged = typed_sources(client, monkeypatch, owner, mode)
    connect(client, actor, owner)
    issued = await client.http.post("/app/widgets/settings", json={
        "operation": "pair", "label": "Synthetic route contract", "mode": mode,
    }, headers=HEADERS)
    assert issued.status == 200
    setup = (await issued.json())["pairing"]["setupCode"]
    downloaded = await client.http.get("/app/widgets/script")
    assert downloaded.status == 200
    script_path = tmp_path / "BookieBot.js"
    script_path.write_text(await downloaded.text(), encoding="utf-8")
    input_path = tmp_path / "contract.json"
    input_path.write_text(json.dumps({
        "origin": ORIGIN, "localOrigin": str(client.http.make_url("/"))[:-1],
        "scriptPath": str(script_path), "setupCode": setup, "ownerName": name, "mode": mode,
        "budgetRemaining": 1234.56 if mode == "current" else 2345.67,
        "availableToday": 22.35 if mode == "current" else -10.55,
        "typed": typed,
    }), encoding="utf-8")
    root = Path(__file__).resolve().parents[2]
    process = await asyncio.create_subprocess_exec(
        node, str(root / "unit_tests/reports/widget_route_contract_test.cjs"), str(input_path),
        cwd=root, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
    )
    try:
        stdout, stderr = await asyncio.wait_for(process.communicate(), timeout=30)
    finally:
        if process.returncode is None:
            process.kill()
            await process.wait()
    assert process.returncode == 0, stderr.decode() or stdout.decode()
    connections = client.widgets.list_connections(owner)["connections"]
    assert len(connections) == 1
    assert connections[0]["status"] == "active"
    assert connections[0]["lastUsedAt"] is not None
    assert len(client.state.calls) == 1, "widget executions should reuse the source snapshot"
    assert financial_state_unchanged(), "all widget types must leave goals, repayments and source projections unchanged"
