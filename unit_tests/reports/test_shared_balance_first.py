"""Real canonical snapshots for the approved Shared UI; never touches Sheets."""
import json
import os
from datetime import timedelta
from pathlib import Path
from uuid import uuid4

from bookiebot.reports.app_access import AppAccessStore
from bookiebot.reimbursements.store import ReimbursementStore
from bookiebot.sheets.routing import now_pacific


def test_balance_first_offset_then_cash_and_sender_confirmation(tmp_path, monkeypatch):
    access = AppAccessStore(tmp_path / "shared.sqlite3")
    access.initialize()
    store = ReimbursementStore(access)
    store.initialize()
    from bookiebot.reimbursements import service
    monkeypatch.setattr(service, "build_reimbursement_store", lambda: store)
    current = now_pacific().date().replace(day=1)
    previous = current - timedelta(days=1)

    def add(identifier, title, amount, date, payer="brian", partner="hannah", settled=0):
        row = store.register_allocation({
            "id": identifier, "payerOwner": payer, "partnerOwner": partner, "payerPerson": payer.title(),
            "item": title, "location": "", "expenseDate": date.isoformat(), "category": "Shopping",
            "sourceWorksheet": "expense", "sourceRow": 10, "sourceActionId": "source-"+identifier,
            "splitActionId": "split-"+identifier, "sourceYear": date.year, "sourceSpreadsheetId": "",
            "grossCents": amount * 2, "payerShareCents": amount, "partnerShareCents": amount,
            "settledCents": settled, "method": "equal", "accounting": "cash_v1",
        })
        store.mark_projected(row["id"], row["version"])

    add("rent", "Rent", 50000, previous)
    add("pge", "PG&E", 5364, current)
    add("water", "Water", 2255, current)
    add("foods", "Whole Foods", 2313, current)
    add("target", "Target", 2395, current, "hannah", "brian")
    add("costco", "Costco", 6130, current, "hannah", "brian")
    add("netflix", "Netflix", 800, current, settled=800)

    def snap():
        return {owner: service.snapshot(owner) for owner in ("brian", "hannah")}

    initial = snap()
    rows = {row["id"]: row for row in initial["brian"]["allocations"]}
    body = {"operation": "offset", "requestId": uuid4().hex, "date": now_pacific().date().isoformat(), "note": "", "entries": [
        {"allocationId": key, "version": rows[key]["version"], "amountCents": amount}
        for key, amount in (("rent", 8525), ("costco", 6130), ("target", 2395))]}
    store.command("brian", body)
    for row in store.snapshot("brian")["allocations"]:
        store.mark_projected(row["id"], row["version"])
    offset = snap()
    sent_body = {"operation": "report_all", "requestId": uuid4().hex, "date": now_pacific().date().isoformat(), "expectedState": offset["hannah"]["resetState"], "note": ""}
    sent = store.command("hannah", sent_body)
    pending = snap()
    assert pending["brian"]["allocations"] == offset["brian"]["allocations"]
    assert sum(event["amountCents"] for event in sent["events"]) == 51407
    receipt_body = {"operation": "receive_all", "requestId": uuid4().hex, "date": now_pacific().date().isoformat(), "expectedState": pending["brian"]["resetState"], "note": ""}
    result = store.command("brian", receipt_body)
    for row in store.snapshot("brian")["allocations"]:
        store.mark_projected(row["id"], row["version"])
    received = snap()
    assert store.command("brian", receipt_body) == result
    assert store.command("hannah", sent_body) == sent
    assert all(row["outstandingCents"] == 0 for row in received["brian"]["allocations"])
    assert sum(event["amountCents"] for event in received["brian"]["events"] if event["kind"] == "offset") == 17050
    assert sum(event["amountCents"] for event in received["brian"]["events"] if event["kind"] != "offset") == 51407
    for row in received["brian"]["allocations"]:
        original = rows[row["id"]]
        for field in ("grossCents", "payerShareCents", "partnerShareCents", "expenseDate", "sourceActionId"):
            assert row[field] == original[field]
    output = os.getenv("BOOKIEBOT_SHARED_BALANCE_FIXTURE")
    if output:
        Path(output).write_text(json.dumps({"initial": initial, "offset": offset, "pending": pending, "received": received, "offsetCommand": body, "month": current.strftime("%Y-%m")}))
