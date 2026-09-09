import hashlib
from types import SimpleNamespace
from uuid import uuid4

import pytest

from bookiebot.intents import handlers
from bookiebot.reimbursements import projection, service, store as store_module
from bookiebot.reimbursements.store import ReimbursementStore
from bookiebot.reports.app_access import AppAccessStore
from bookiebot.sheets.routing import now_pacific

BRIAN = "676638528590970917"
HANNAH = "830984827904851969"


class Channel:
    def __init__(self):
        self.sent = []

    async def send(self, content):
        self.sent.append(content)


def message(actor=BRIAN, identifier: int | None = 123456789012345678):
    return SimpleNamespace(id=identifier, content="Hannah reimbursed PG&E", author=SimpleNamespace(id=int(actor)), channel=Channel())


def request_id(msg):
    return hashlib.sha256(f"discord-receipt:{msg.author.id}:{msg.id}".encode()).hexdigest()


def allocation_payload(**changes):
    identifier = uuid4().hex
    return {"id": identifier, "payerOwner": "brian", "partnerOwner": "hannah", "payerPerson": "Brian (BofA)",
            "item": "PG&E", "location": "Utility", "expenseDate": "2026-01-03", "category": "need_expenses",
            "sourceWorksheet": "expense", "sourceRow": 3, "sourceActionId": "source-" + identifier,
            "splitActionId": "split-" + identifier, "sourceYear": 2026, "sourceSpreadsheetId": "",
            "grossCents": 10000, "payerShareCents": 6000, "partnerShareCents": 4000,
            "settledCents": 0, "method": "income", "accounting": "cash_v1", **changes}


def payment(allocation, msg, amount):
    return {"operation": "receive", "requestId": request_id(msg), "allocationId": allocation["id"],
            "version": allocation["version"], "amountCents": amount,
            "date": now_pacific().date().isoformat(), "note": "Recorded in Discord"}


@pytest.fixture
def setup(tmp_path, monkeypatch):
    access = AppAccessStore(tmp_path / "receipts.sqlite3")
    store = ReimbursementStore(access)
    store.initialize()
    allocation = store.register_allocation(allocation_payload())
    monkeypatch.setenv("BOOKIEBOT_REIMBURSEMENTS_ENABLED", "true")
    monkeypatch.setattr(service, "build_reimbursement_store", lambda: store)
    monkeypatch.setattr(store_module, "build_reimbursement_store", lambda: store)
    syncs = []

    def sync(target):
        assert target is store
        syncs.append(target)
        return False

    def legacy_write(*_args, **_kwargs):
        pytest.fail("Canonical receipt errors must never fall through to legacy sheet writes")

    monkeypatch.setattr(projection, "sync_pending", sync)
    monkeypatch.setattr(handlers, "mark_reimbursed", legacy_write)
    monkeypatch.setattr(handlers, "matching_outstanding_allocations", legacy_write)
    return SimpleNamespace(store=store, allocation=allocation, syncs=syncs)


@pytest.mark.asyncio
@pytest.mark.parametrize("supplied,expected", [(None, 4000), ("12.34", 1234)])
async def test_duplicate_delivery_recovers_exact_committed_full_or_partial_receipt(setup, monkeypatch, supplied, expected):
    msg = message()
    original = service.command

    def commit_then_lose_response(owner, body):
        original(owner, body)
        raise ConnectionError("Response lost after durable commit")

    monkeypatch.setattr(service, "command", commit_then_lose_response)
    entities = {"item": "PG&E", **({"amount": supplied} if supplied is not None else {})}
    await handlers.mark_shared_reimbursement_received_handler(entities, msg)
    before = setup.store.snapshot("brian")
    assert before["allocations"][0]["settledCents"] == expected
    assert len(before["events"]) == 1 and len(setup.syncs) == 1
    assert "couldn't verify" in msg.channel.sent[-1]

    def unexpected(*_args, **_kwargs):
        pytest.fail("A committed Discord message must recover before matching or issuing another receipt")

    monkeypatch.setattr(service, "matching", unexpected)
    monkeypatch.setattr(service, "command", unexpected)
    # Re-parsing or the remaining balance must not change the original command.
    await handlers.mark_shared_reimbursement_received_handler({"item": "Different parse", "amount": "0.01"}, msg)
    assert setup.store.snapshot("brian") == before
    assert len(setup.syncs) == 2
    assert f"already recorded ${expected / 100:.2f} received from Hannah" in msg.channel.sent[-1]
    assert "still syncing" in msg.channel.sent[-1]


@pytest.mark.asyncio
@pytest.mark.parametrize("amount", [1000, 4000])
async def test_delivery_race_recovers_after_outstanding_match_or_version_changed(setup, monkeypatch, amount):
    msg = message()
    setup.store.command("brian", payment(setup.allocation, msg, amount))
    original = setup.store.get_command_result
    reads = 0

    def stale_first_read(owner, identifier):
        nonlocal reads
        reads += 1
        return None if reads == 1 else original(owner, identifier)

    monkeypatch.setattr(setup.store, "get_command_result", stale_first_read)
    await handlers.mark_shared_reimbursement_received_handler({"item": "PG&E"}, msg)
    snapshot = setup.store.snapshot("brian")
    assert snapshot["allocations"][0]["settledCents"] == amount
    assert snapshot["allocations"][0]["version"] == 2
    assert len(snapshot["events"]) == 1
    assert f"already recorded ${amount / 100:.2f}" in msg.channel.sent[-1]
    assert reads == 2


@pytest.mark.asyncio
async def test_same_message_number_is_scoped_to_its_authenticated_actor(setup):
    brian = message()
    await handlers.mark_shared_reimbursement_received_handler({"item": "PG&E", "amount": "10.00"}, brian)
    hannah = message(HANNAH, brian.id)
    await handlers.mark_shared_reimbursement_received_handler({"item": "PG&E"}, hannah)
    assert request_id(brian) != request_id(hannah)
    assert "already recorded" not in hannah.channel.sent[-1]
    assert "Name one reimbursement" in hannah.channel.sent[-1]
    assert len(setup.store.snapshot("brian")["events"]) == 1


@pytest.mark.asyncio
async def test_cached_command_owned_by_another_person_never_recovers_or_falls_back(setup):
    opposite = setup.store.register_allocation(allocation_payload(payerOwner="hannah", partnerOwner="brian", payerPerson="Hannah"))
    msg = message()
    setup.store.command("hannah", payment(opposite, msg, 1000))
    before = setup.store.snapshot("brian")
    await handlers.mark_shared_reimbursement_received_handler({"item": "PG&E"}, msg)
    assert setup.store.snapshot("brian") == before
    assert "couldn't verify" in msg.channel.sent[-1]
    assert "already recorded" not in msg.channel.sent[-1]
    assert not setup.syncs


@pytest.mark.asyncio
@pytest.mark.parametrize("stage", ["factory", "lookup"])
async def test_unavailable_canonical_storage_never_reaches_matching_or_legacy_writes(setup, monkeypatch, stage):
    def unavailable(*_args, **_kwargs):
        raise ConnectionError("Canonical storage unavailable")

    def unexpected(*_args, **_kwargs):
        pytest.fail("No outstanding-row fallback is safe without the durable command check")

    monkeypatch.setattr(store_module if stage == "factory" else setup.store,
                        "build_reimbursement_store" if stage == "factory" else "get_command_result", unavailable)
    monkeypatch.setattr(service, "matching", unexpected)
    msg = message()
    await handlers.mark_shared_reimbursement_received_handler({"item": "PG&E"}, msg)
    assert setup.store.snapshot("brian")["events"] == []
    assert "couldn't verify" in msg.channel.sent[-1]


@pytest.mark.asyncio
async def test_committed_receipt_survives_another_projection_failure_before_recovery(setup, monkeypatch):
    msg = message()
    setup.store.command("brian", payment(setup.allocation, msg, 1000))

    def unavailable(_store):
        raise ConnectionError("Projection unavailable")

    monkeypatch.setattr(projection, "sync_pending", unavailable)
    await handlers.mark_shared_reimbursement_received_handler({"item": "PG&E"}, msg)
    assert "couldn't verify" in msg.channel.sent[-1]
    monkeypatch.setattr(projection, "sync_pending", lambda _store: True)
    await handlers.mark_shared_reimbursement_received_handler({"item": "PG&E"}, msg)
    assert "already recorded $10.00" in msg.channel.sent[-1]
    assert "Both expense records were updated" in msg.channel.sent[-1]
    assert len(setup.store.snapshot("brian")["events"]) == 1
    assert setup.store.get_allocation(setup.allocation["id"])["version"] == 2


@pytest.mark.asyncio
async def test_missing_stable_message_id_cannot_start_a_receipt(setup, monkeypatch):
    msg = message(identifier=None)

    def unexpected():
        pytest.fail("Missing message identity must be rejected before opening the ledger")

    monkeypatch.setattr(store_module, "build_reimbursement_store", unexpected)
    await handlers.mark_shared_reimbursement_received_handler({"item": "PG&E"}, msg)
    assert "record this payment safely" in msg.channel.sent[-1]
    assert setup.store.snapshot("brian")["events"] == []


def test_report_overlay_preserves_cash_spending_and_uses_owner_canonical_receipts(setup):
    from bookiebot.reports.expense_breakdown import BudgetMonth, ReportWorksheets, build_expense_breakdown_report
    from unit_tests.support.sheets_repo_stub import InMemoryWorksheet

    msg = message()
    setup.store.command("brian", payment(setup.allocation, msg, 1000))
    setup.store.register_allocation(allocation_payload(payerOwner="hannah", partnerOwner="brian", payerPerson="Hannah"))
    row = [""] * 34
    row[29:34] = ["1/3/2026", "PG&E", "90.00", "Utility", "Brian (BofA)"]
    report = build_expense_breakdown_report(actor_key=BRIAN, owner_name="Brian", persons=["Brian (BofA)", "Brian (AL)"],
                                          month=BudgetMonth(2026, 1), worksheets=ReportWorksheets(
                                              shared_expenses=InMemoryWorksheet([["header"] * 34, ["header"] * 34, row]),
                                              personal_budget=InMemoryWorksheet([])))
    assert report.shared_total == 90, "The canonical display must not replace cash spending with the eventual $60 share"
    assert [item.allocation_id for item in report.shared_reimbursements] == [setup.allocation["id"]]
    assert report.shared_reimbursements[0].gross_amount == 100
    assert report.shared_reimbursements[0].received_amount == 10
    assert report.shared_reimbursements[0].outstanding_amount == 30
    assert report.reimbursement_coverage is not None and report.reimbursement_coverage["status"] == "partial"
    setup.store.command("brian", payment(setup.store.get_allocation(setup.allocation["id"]), message(identifier=987654321), 3000))
    complete = build_expense_breakdown_report(actor_key=BRIAN, owner_name="Brian", persons=["Brian (BofA)"],
                                            month=BudgetMonth(2026, 1), worksheets=ReportWorksheets(
                                                shared_expenses=InMemoryWorksheet([]), personal_budget=InMemoryWorksheet([])))
    assert complete.open_shared_reimbursements == []
    assert complete.received_shared_reimbursements is not None
    assert [item.allocation_id for item in complete.received_shared_reimbursements] == [setup.allocation["id"]]
