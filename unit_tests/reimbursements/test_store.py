from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
import os
from threading import Barrier
from uuid import uuid4

import pytest

from bookiebot.reports.app_access import AppAccessStore, PostgresAppAccessStore
from bookiebot.reimbursements.store import (
    MAX_CENTS, ReimbursementConflictError, ReimbursementNotFoundError, ReimbursementStore,
    ReimbursementValidationError,
)
from bookiebot.sheets.routing import now_pacific


@pytest.fixture(params=["sqlite", "postgres"])
def access(request, tmp_path):
    if request.param == "sqlite":
        yield AppAccessStore(tmp_path / "reimbursements.sqlite3")
        return
    url = os.getenv("BOOKIEBOT_TEST_POSTGRES_URL", "")
    if not url:
        pytest.skip("Set BOOKIEBOT_TEST_POSTGRES_URL for isolated Postgres reimbursement contracts")
    import psycopg
    from psycopg import sql
    from psycopg.conninfo import make_conninfo
    schema = "bookiebot_reimbursements_" + uuid4().hex
    with psycopg.connect(url, autocommit=True, connect_timeout=5) as admin:
        admin.execute(sql.SQL("CREATE SCHEMA {}").format(sql.Identifier(schema)))
        try:
            yield PostgresAppAccessStore(make_conninfo(url, options=f"-csearch_path={schema}", connect_timeout=5))
        finally:
            admin.execute(sql.SQL("DROP SCHEMA {} CASCADE").format(sql.Identifier(schema)))


@pytest.fixture
def store(access):
    result = ReimbursementStore(access)
    result.initialize()
    return result


def payload(**changes):
    identifier = uuid4().hex
    return {"id": identifier, "payerOwner": "brian", "partnerOwner": "hannah", "payerPerson": "Brian (BofA)",
            "item": "PG&E", "location": "Utility", "expenseDate": "2026-01-03", "category": "Need",
            "sourceWorksheet": "JAN26", "sourceRow": 10, "sourceActionId": "source-" + identifier,
            "splitActionId": "split-" + identifier, "sourceYear": 2026, "sourceSpreadsheetId": "",
            "grossCents": 10000, "payerShareCents": 6000, "partnerShareCents": 4000,
            "settledCents": 0, "method": "income", "accounting": "cash_v1", **changes}


def command(operation, **changes):
    return {"operation": operation, "requestId": uuid4().hex, **changes}


def payment(allocation, amount=1000, operation="receive", **changes):
    return command(operation, allocationId=allocation["id"], version=allocation["version"],
                   amountCents=amount, date=now_pacific().date().isoformat(), note="Recorded transfer", **changes)


def opposite(store):
    return store.register_allocation(payload(payerOwner="hannah", partnerOwner="brian", payerPerson="Hannah"))


def offset(first, second, amount=1000):
    return command("offset", entries=[{"allocationId": a["id"], "version": a["version"], "amountCents": amount}
                                       for a in (first, second)], date=now_pacific().date().isoformat(), note="Agreed offset")


def test_initialize_concurrently_and_registration_survives_restart(access):
    barrier = Barrier(4)
    def initialize(_):
        barrier.wait(timeout=10)
        ReimbursementStore(access).initialize()
    with ThreadPoolExecutor(max_workers=4) as executor:
        list(executor.map(initialize, range(4)))
    store = ReimbursementStore(access)
    data = payload(sourceValues={"item": "PG&E", "amount": "$100.00"}, sourceColumnMap={"item": 8, "amount": 9},
                   actorKey="discord-123", ledgerSpreadsheetId="ledger", ledgerYear=2026, originalPerson="Brian",
                   legacyReceivedAt="")
    allocation = store.register_allocation(data)
    assert allocation["version"] == 1 and allocation["projectedVersion"] == 0
    assert allocation["outstandingCents"] == 4000 and allocation["status"] == "outstanding"
    assert ReimbursementStore(access).get_allocation(data["id"]) == allocation
    assert store.snapshot("brian") == store.snapshot("hannah")
    assert store.snapshot("hannah")["allocations"] == [allocation]
    assert allocation["sourceValues"] == data["sourceValues"]
    assert allocation["sourceColumnMap"] == data["sourceColumnMap"]
    assert store.snapshot("brian")["events"] == []


def test_registration_identity_and_source_uniqueness(store):
    data = payload()
    first = store.register_allocation(data)
    assert store.register_allocation(data) == first
    for change in ({"grossCents": 11000, "payerShareCents": 7000}, {"item": "Different"}, {"sourceRow": 11},
                   {"payerOwner": "hannah", "partnerOwner": "brian", "payerPerson": "Hannah"}):
        with pytest.raises(ReimbursementConflictError):
            store.register_allocation({**data, **change})
    with pytest.raises(ReimbursementConflictError):
        store.register_allocation({**data, "id": uuid4().hex})
    paid = store.command("brian", payment(first))["allocations"][0]
    assert store.register_allocation(data) == paid, "Registration retries must never reset confirmed balances"
    assert len(store.snapshot("brian")["allocations"]) == 1


def test_command_result_recovery_returns_original_committed_result_without_weakening_idempotency(store):
    allocation = store.register_allocation(payload())
    body = payment(allocation)
    assert store.get_command_result("brian", body["requestId"]) is None
    original = store.command("brian", body)
    store.command("brian", command("reverse", eventId=original["events"][0]["id"]))
    assert store.get_command_result("brian", body["requestId"]) == original
    with pytest.raises(ReimbursementConflictError):
        store.get_command_result("hannah", body["requestId"])
    with pytest.raises(ReimbursementConflictError):
        store.command("brian", body | {"version": store.get_allocation(allocation["id"])["version"]})
    with pytest.raises(ReimbursementValidationError):
        store.get_command_result("brian", "invalid")


def test_simultaneous_duplicate_registration_claims_one_source(store):
    data = payload()
    with ThreadPoolExecutor(max_workers=4) as executor:
        results = list(executor.map(lambda _: store.register_allocation(data), range(4)))
    assert results == [results[0]] * 4
    assert len(store.snapshot("brian")["allocations"]) == 1


def test_receive_updates_only_payee_confirmed_amounts_and_projection(store):
    allocation = store.register_allocation(payload(settledCents=500, accounting="cash_v1"))
    assert store.pending_projections()[0]["events"] == []
    assert store.mark_projected(allocation["id"], 1)
    body = payment(allocation, 1000)
    result = store.command("brian", body)
    updated, event = result["allocations"][0], result["events"][0]
    assert updated["settledCents"] == 1500 and updated["outstandingCents"] == 2500 and updated["version"] == 2
    assert event["status"] == "confirmed" and event["kind"] == "receive"
    assert event["payeeOwner"] == "brian" and event["debtorOwner"] == "hannah" and event["actorOwner"] == "brian"
    assert event["confirmedBy"] == "brian" and event["amountCents"] == 1000
    assert store.pending_projections() == [{**updated, "events": [event]}]
    assert not store.mark_projected(allocation["id"], 1)
    assert store.mark_projected(allocation["id"], 2)
    assert store.mark_projected(allocation["id"], 2)
    assert store.pending_projections() == []
    assert not store.mark_projected("missing", 1)
    assert store.command("brian", body) == result


def test_pending_report_confirmation_and_cancellation_are_explicit(store):
    allocation = store.register_allocation(payload())
    store.mark_projected(allocation["id"], 1)
    report = store.command("hannah", payment(allocation, 1500, "report_payment"))
    assert report["allocations"] == []
    event = report["events"][0]
    assert event["status"] == "pending" and event["amountCents"] == 1500
    assert not event["confirmedAt"] and not event["confirmedBy"]
    assert store.get_allocation(allocation["id"])["settledCents"] == 0
    assert store.get_allocation(allocation["id"])["version"] == 1
    assert store.pending_projections() == []
    confirm = command("confirm_payment", allocationId=allocation["id"], version=1, eventId=event["id"])
    with pytest.raises(ReimbursementValidationError):
        store.command("hannah", confirm)
    result = store.command("brian", confirm)
    assert result["allocations"][0]["settledCents"] == 1500
    assert result["events"][0]["actorOwner"] == "hannah" and result["events"][0]["confirmedBy"] == "brian"
    assert result["events"][0]["date"] == event["date"] and result["events"][0]["note"] == event["note"]
    assert store.command("brian", confirm) == result
    reversed_result = store.command("hannah", command("reverse", eventId=event["id"]))
    assert reversed_result["allocations"][0]["settledCents"] == 0
    assert reversed_result["allocations"][0]["version"] == 3
    saved = store.snapshot("brian")["events"][0]
    assert saved["status"] == "reversed" and saved["reversedBy"] == "hannah" and saved["confirmedAt"]


@pytest.mark.parametrize("owner", ["brian", "hannah"])
def test_pending_report_can_be_canceled_without_balance_or_version_change(store, owner):
    allocation = store.register_allocation(payload())
    event = store.command("hannah", payment(allocation, 1000, "report_payment"))["events"][0]
    result = store.command(owner, command("reverse", eventId=event["id"]))
    assert result["allocations"] == [] and result["events"][0]["status"] == "reversed"
    assert store.get_allocation(allocation["id"])["version"] == 1
    with pytest.raises(ReimbursementConflictError):
        store.command("brian", command("confirm_payment", allocationId=allocation["id"], version=1, eventId=event["id"]))


def test_pending_sum_and_receipt_confirmation_cannot_overpay(store):
    allocation = store.register_allocation(payload())
    report = store.command("hannah", payment(allocation, 3000, "report_payment"))
    with pytest.raises(ReimbursementConflictError, match="Pending"):
        store.command("hannah", payment(allocation, 1001, "report_payment"))
    with pytest.raises(ReimbursementConflictError, match="Confirm or dismiss"):
        store.command("brian", payment(allocation, 2000))
    assert store.get_allocation(allocation["id"])["settledCents"] == 0
    received = store.command("brian", command("confirm_payment", allocationId=allocation["id"], version=1, eventId=report["events"][0]["id"]))["allocations"][0]
    assert received["settledCents"] == 3000
    with pytest.raises(ReimbursementConflictError, match="exceeds"):
        store.command("brian", payment(received, 1001))


@pytest.mark.parametrize("operation,owner", [("receive", "hannah"), ("report_payment", "brian")])
def test_payment_direction_is_authorized_server_side(store, operation, owner):
    allocation = store.register_allocation(payload())
    with pytest.raises(ReimbursementValidationError):
        store.command(owner, payment(allocation, operation=operation))
    assert store.get_allocation(allocation["id"])["settledCents"] == 0
    assert store.snapshot("brian")["events"] == []


def test_request_fingerprint_is_global_actor_bound_and_durable(store):
    allocation = store.register_allocation(payload())
    body = payment(allocation)
    result = store.command("brian", body)
    assert ReimbursementStore(store.access).command("brian", body) == result
    with pytest.raises(ReimbursementConflictError, match="identifier"):
        store.command("brian", {**body, "amountCents": 999})
    with pytest.raises(ReimbursementConflictError, match="identifier"):
        store.command("hannah", body)
    assert len(store.snapshot("brian")["events"]) == 1


def test_concurrent_duplicate_command_settles_once(store):
    allocation = store.register_allocation(payload())
    body = payment(allocation)
    with ThreadPoolExecutor(max_workers=4) as executor:
        results = list(executor.map(lambda _: store.command("brian", body), range(4)))
    assert results == [results[0]] * 4
    assert store.get_allocation(allocation["id"])["settledCents"] == 1000
    assert len(store.snapshot("brian")["events"]) == 1


def test_concurrent_distinct_commands_cannot_both_use_stale_version(store):
    allocation = store.register_allocation(payload())
    barrier = Barrier(2)
    def run(_):
        barrier.wait(timeout=10)
        try:
            return store.command("brian", payment(allocation, 3000))
        except ReimbursementConflictError:
            return None
    with ThreadPoolExecutor(max_workers=2) as executor:
        results = list(executor.map(run, range(2)))
    assert sum(result is not None for result in results) == 1
    assert store.get_allocation(allocation["id"])["settledCents"] == 3000


@pytest.mark.parametrize("owner", ["brian", "hannah"])
def test_offset_and_reverse_are_balanced_atomic_groups(store, owner):
    first, second = store.register_allocation(payload()), opposite(store)
    body = offset(first, second)
    result = store.command("brian", body)
    assert len(result["allocations"]) == 2 and len(result["events"]) == 2
    assert {e["operationId"] for e in result["events"]} == {result["operationId"]}
    assert all(a["settledCents"] == 1000 and a["version"] == 2 for a in result["allocations"])
    assert store.command("brian", body) == result
    reverse = command("reverse", eventId=result["events"][0]["id"])
    reversed_result = store.command(owner, reverse)
    assert len(reversed_result["events"]) == 2
    assert all(a["settledCents"] == 0 and a["version"] == 3 for a in reversed_result["allocations"])
    assert all(e["status"] == "reversed" and e["reversalOperationId"] == reversed_result["operationId"] for e in reversed_result["events"])
    assert store.command(owner, reverse) == reversed_result
    with pytest.raises(ReimbursementConflictError, match="already reversed"):
        store.command(owner, command("reverse", eventId=result["events"][1]["id"]))


@pytest.mark.parametrize("kind", ["unbalanced", "same_direction", "duplicate", "stale", "overpay", "extra_field"])
def test_invalid_offset_changes_neither_direction(store, kind):
    first, second = store.register_allocation(payload()), opposite(store)
    body = offset(first, second)
    if kind == "unbalanced":
        body["entries"][1]["amountCents"] += 1
    elif kind == "same_direction":
        third = store.register_allocation(payload())
        body["entries"][1]["allocationId"] = third["id"]
    elif kind == "duplicate":
        body["entries"][1] = body["entries"][0]
    elif kind == "stale":
        body["entries"][1]["version"] = 2
    elif kind == "overpay":
        body["entries"][1]["amountCents"] = 4001
    else:
        body["entries"][0]["owner"] = "hannah"
    before = store.snapshot("brian")
    with pytest.raises((ReimbursementConflictError, ReimbursementValidationError)):
        store.command("brian", body)
    assert store.snapshot("brian") == before


def test_failed_atomic_offset_rolls_back_claim_events_and_first_leg(store, monkeypatch):
    first, second = store.register_allocation(payload()), opposite(store)
    body = offset(first, second)
    original = store._settle
    count = 0
    def fail_second(db, allocation_id, amount, now):
        nonlocal count
        count += 1
        claim = db.execute("SELECT result_json FROM app_reimbursement_commands WHERE request_id = ?", (body["requestId"],)).fetchone()
        assert claim is not None and claim["result_json"] == "", "Claim must precede balance/event work"
        original(db, allocation_id, amount, now)
        if count == 2:
            raise RuntimeError("Synthetic connection failure before commit")
    monkeypatch.setattr(store, "_settle", fail_second)
    before = store.snapshot("brian")
    with pytest.raises(RuntimeError, match="Synthetic"):
        store.command("brian", body)
    assert store.snapshot("brian") == before
    with store.access.connect() as db:
        assert db.execute("SELECT COUNT(*) AS count FROM app_reimbursement_commands").fetchone()["count"] == 0
    monkeypatch.setattr(store, "_settle", original)
    assert len(store.command("brian", body)["allocations"]) == 2


def test_reverse_receipt_not_permitted_to_debtor_and_version_cannot_be_reused(store):
    allocation = store.register_allocation(payload())
    result = store.command("brian", payment(allocation, 4000))
    assert result["allocations"][0]["status"] == "settled"
    with pytest.raises(ReimbursementValidationError):
        store.command("hannah", command("reverse", eventId=result["events"][0]["id"]))
    with pytest.raises(ReimbursementConflictError):
        store.command("brian", payment(allocation))
    reversed_result = store.command("brian", command("reverse", eventId=result["events"][0]["id"]))
    assert reversed_result["allocations"][0]["status"] == "outstanding"
    assert len(store.snapshot("brian")["events"]) == 1


def test_foreign_payment_event_cannot_confirm_another_allocation(store):
    first, second = store.register_allocation(payload()), store.register_allocation(payload())
    report = store.command("hannah", payment(first, operation="report_payment"))
    with pytest.raises(ReimbursementNotFoundError):
        store.command("brian", command("confirm_payment", allocationId=second["id"], version=1, eventId=report["events"][0]["id"]))
    with pytest.raises(ReimbursementNotFoundError):
        store.command("brian", command("reverse", eventId="missing"))


def test_attach_source_is_metadata_only_versioned_and_retry_safe(store):
    original = payload(splitActionId="")
    first = store.register_allocation(original)
    store.mark_projected(first["id"], 1)
    updated = store.attach_source(first["id"], {"splitActionId": "confirmed-split", "sourceRow": 11})
    assert updated["version"] == 2 and updated["settledCents"] == 0
    assert updated["splitActionId"] == "confirmed-split" and updated["sourceRow"] == 11
    assert store.attach_source(first["id"], {"splitActionId": "confirmed-split", "sourceRow": 11}) == updated
    assert store.register_allocation(original) == updated
    assert not store.mark_projected(first["id"], 1)
    assert store.pending_projections()[0]["version"] == 2
    with pytest.raises(ReimbursementValidationError):
        store.attach_source(first["id"], {"settledCents": 100})
    with pytest.raises(ReimbursementConflictError):
        store.attach_source(first["id"], {"splitActionId": "other-split"})


@pytest.mark.parametrize("field,value", [("grossCents", True), ("grossCents", 10000.0), ("grossCents", MAX_CENTS + 1),
    ("payerShareCents", -1), ("partnerShareCents", 100), ("settledCents", 4001), ("settledCents", -1),
    ("payerOwner", "other"), ("partnerOwner", "brian"), ("expenseDate", "2026-02-30"), ("expenseDate", "2026-1-03"),
    ("sourceYear", True), ("sourceRow", 0), ("method", "unknown"), ("accounting", "unknown"), ("id", ""),
    ("sourceActionId", ""), ("item", "bad\nitem"), ("sourceValues", {"amount": 2}), ("sourceColumnMap", {"amount": True}),
    ("unexpected", "field")])
def test_invalid_allocation_values_do_not_persist(store, field, value):
    with pytest.raises(ReimbursementValidationError):
        store.register_allocation(payload(**{field: value}))
    assert store.snapshot("brian")["allocations"] == []


@pytest.mark.parametrize("changes", [{"amountCents": True}, {"amountCents": 0}, {"amountCents": 1.1}, {"amountCents": MAX_CENTS+1},
    {"date": "2026-02-30"}, {"date": "tomorrow"}, {"note": "x"*501}, {"note": "a\nb"}, {"owner": "hannah"},
    {"requestId": "short"}, {"amountCents": float("nan")}, {"version": True}])
def test_invalid_payment_has_no_partial_event_or_claim(store, changes):
    allocation = store.register_allocation(payload())
    with pytest.raises((ReimbursementValidationError, ReimbursementConflictError)):
        store.command("brian", {**payment(allocation), **changes})
    assert store.snapshot("brian")["events"] == []


def test_future_payments_and_unmapped_accounts_are_rejected(store):
    allocation = store.register_allocation(payload())
    with pytest.raises(ReimbursementValidationError):
        store.command("brian", {**payment(allocation), "date": (now_pacific().date()+timedelta(days=1)).isoformat()})
    for owner in ("other", "Brian", "", None, True):
        with pytest.raises(ReimbursementValidationError):
            store.snapshot(owner)
        with pytest.raises(ReimbursementValidationError):
            store.command(owner, payment(allocation))


def test_fronted_equal_and_legacy_baseline_allocation_invariants(store):
    fronted = store.register_allocation(payload(method="fronted", payerShareCents=0, partnerShareCents=10000, settledCents=10000, accounting="legacy_net"))
    assert fronted["status"] == "settled" and fronted["projectedVersion"] == 0
    odd_equal = store.register_allocation(payload(method="equal", grossCents=3, payerShareCents=2, partnerShareCents=1))
    assert odd_equal["outstandingCents"] == 1
    with pytest.raises(ReimbursementValidationError):
        store.register_allocation(payload(method="equal"))
    with pytest.raises(ReimbursementValidationError):
        store.register_allocation(payload(method="fronted"))


def test_source_lookup_preserves_raw_cells_baseline_and_actual_sheet_title(store):
    data = payload(settledCents=500, sourceSheetTitle="FEB26", sourceValues={"item": "  PG&E  ", "amount": "$100.00"})
    assert store.find_by_source(data["sourceActionId"], 2026) is None
    allocation = store.register_allocation(data)
    assert store.find_by_source(data["sourceActionId"], 2026) == allocation
    assert allocation["sourceValues"]["item"] == "  PG&E  "
    assert allocation["baselineSettledCents"] == 500 and allocation["sourceSheetTitle"] == "FEB26"
    received = store.command("brian", payment(allocation))["allocations"][0]
    assert received["settledCents"] == 1500 and received["baselineSettledCents"] == 500
    assert store.find_by_source(data["sourceActionId"], 2026) == received
    with pytest.raises(ReimbursementValidationError):
        store.register_allocation(payload(baselineSettledCents=100))


@pytest.mark.parametrize("payer,owner,valid", [("Brian", "brian", True), ("Brian (AL)", "brian", True),
    ("Brian (BofA)", "brian", True), ("Hannah", "hannah", True), ("Hannah", "brian", False),
    ("Brian (BofA)", "hannah", False), ("Unknown", "brian", False)])
def test_payer_person_must_match_the_mapped_account(store, payer, owner, valid):
    data = payload(payerPerson=payer, payerOwner=owner, partnerOwner="hannah" if owner == "brian" else "brian")
    if valid:
        assert store.register_allocation(data)["payerPerson"] == payer
    else:
        with pytest.raises(ReimbursementValidationError, match="mapped account"):
            store.register_allocation(data)


@pytest.mark.parametrize("operation", ["receive", "report_payment", "confirm_payment", "offset"])
def test_legacy_net_allocations_are_read_only(store, operation):
    allocation = store.register_allocation(payload(accounting="legacy_net"))
    if operation == "offset":
        body = offset(allocation, opposite(store))
    elif operation == "confirm_payment":
        body = command(operation, allocationId=allocation["id"], version=1, eventId="missing")
    else:
        body = payment(allocation, operation=operation)
    with pytest.raises(ReimbursementConflictError, match="read-only"):
        store.command("hannah" if operation == "report_payment" else "brian", body)
    assert store.get_allocation(allocation["id"])["version"] == 1
    assert store.snapshot("brian")["events"] == []


def test_opposite_owner_concurrent_offsets_share_one_household_lock(store):
    first, second = store.register_allocation(payload()), opposite(store)
    barrier = Barrier(2)
    def run(owner):
        barrier.wait(timeout=10)
        try:
            return store.command(owner, offset(first, second, 3000))
        except ReimbursementConflictError:
            return None
    with ThreadPoolExecutor(max_workers=2) as executor:
        results = list(executor.map(run, ("brian", "hannah")))
    assert sum(result is not None for result in results) == 1
    snapshot = store.snapshot("brian")
    assert all(a["settledCents"] == 3000 and a["version"] == 2 for a in snapshot["allocations"])
    assert len(snapshot["events"]) == 2


def test_snapshots_never_mix_balance_and_event_revisions(store):
    allocation = store.register_allocation(payload())
    def writer():
        current = allocation
        for _ in range(12):
            current = store.command("brian", payment(current, 100))["allocations"][0]
    def reader():
        for _ in range(20):
            snapshot = store.snapshot("hannah")
            current = snapshot["allocations"][0]
            confirmed = sum(e["amountCents"] for e in snapshot["events"] if e["status"] == "confirmed")
            assert current["settledCents"] == current["baselineSettledCents"] + confirmed
            assert current["outstandingCents"] == current["partnerShareCents"] - current["settledCents"]
    with ThreadPoolExecutor(max_workers=3) as executor:
        futures = [executor.submit(writer), executor.submit(reader), executor.submit(reader)]
        for future in futures:
            future.result(timeout=15)
    assert store.get_allocation(allocation["id"])["settledCents"] == 1200


def test_offset_waits_for_pending_cash_report_to_be_resolved(store):
    first, second = store.register_allocation(payload()), opposite(store)
    report = store.command("hannah", payment(first, operation="report_payment"))
    before = store.snapshot("brian")
    with pytest.raises(ReimbursementConflictError, match="Confirm or dismiss"):
        store.command("brian", offset(first, second))
    assert store.snapshot("brian") == before
    store.command("hannah", command("reverse", eventId=report["events"][0]["id"]))
    assert len(store.command("brian", offset(first, second))["allocations"]) == 2


@pytest.mark.parametrize("operation", ["receive", "report_payment", "offset"])
def test_settlement_date_cannot_precede_any_selected_expense(store, operation):
    first = store.register_allocation(payload())
    body = offset(first, opposite(store)) if operation == "offset" else payment(first, operation=operation)
    body["date"] = "2026-01-02"
    with pytest.raises(ReimbursementValidationError, match="before the expense"):
        store.command("hannah" if operation == "report_payment" else "brian", body)
    assert store.snapshot("brian")["events"] == []
