from dataclasses import replace
from datetime import datetime
from types import SimpleNamespace

import pytest
from unittest.mock import AsyncMock

from bookiebot.sheets import collaboration
from bookiebot.sheets.routing import PACIFIC_TZ, sheet_user_context
from unit_tests.support.sheets_repo_stub import InMemoryWorksheet, SheetsRepoStub


BRIAN = "676638528590970917"
HANNAH = "830984827904851969"


class ReceiptWorksheet(InMemoryWorksheet):
    def __init__(self, rows):
        super().__init__(rows, title="Shared Reimbursements")
        self.batch_calls = []

    def batch_update(self, updates):
        self.batch_calls.append(updates)
        for update in updates:
            self.update(update["values"], range_name=update["range"])


def allocation(**changes):
    result = collaboration.new_allocation(
        actor_key=BRIAN,
        payer="Brian (BofA)",
        source_action_id="older-expense",
        source_worksheet="expense",
        source_category="grocery",
        source_row=17,
        expense_date="12/22/2025",
        item="Groceries",
        location="Safeway",
        gross_amount=200,
        split_method="equal",
        payer_share=100,
        partner_share=100,
    )
    return replace(result, **changes)


def mock_history(monkeypatch, records, *, on_read=None, complete=None):
    import bookiebot.sheets.reimbursement_history as history

    calls = []

    def read(actor_key, *, as_of):
        calls.append(actor_key)
        if on_read:
            on_read()
        return SimpleNamespace(
            records=records,
            outstanding_records=tuple(item for item in records if item.allocation.status == "outstanding"
                                      and item.allocation.outstanding_amount > 0),
            require_complete=complete or (lambda: None),
        )

    monkeypatch.setattr(history, "read_reimbursement_history", read)
    return calls


def record(item, ws, row_number=2):
    return SimpleNamespace(allocation=item, worksheet=ws, row_number=row_number, year=2025)


def test_settles_authoritative_prior_year_without_copying_or_changing_expenses(monkeypatch):
    original = allocation(actor_key="shortcut:brian")
    old = ReceiptWorksheet([collaboration.SHARED_REIMBURSEMENT_HEADERS, collaboration._allocation_row(original)])
    repo = SheetsRepoStub(expense_rows=[["unchanged shared expense"]], income_rows=[["unchanged income"]])
    before = old.get_all_values()[1]
    calls = mock_history(monkeypatch, (record(original, old),))
    received_at = datetime(2026, 1, 4, 13, 30, tzinfo=PACIFIC_TZ)

    with repo.patched(), sheet_user_context(HANNAH):
        updated = collaboration.mark_reimbursed(original.allocation_id, actor_key=BRIAN, received_at=received_at)

    assert calls == [BRIAN]
    assert updated is not None and updated.status == "reimbursed"
    assert updated.received_amount == 100 and updated.outstanding_amount == 0
    assert updated.received_at == received_at.isoformat(timespec="seconds")
    assert repo.shared_reimbursements.get_all_values() == []
    assert repo.expense.get_all_values() == [["unchanged shared expense"]]
    assert repo.income.get_all_values() == [["unchanged income"]]
    after = old.get_all_values()[1]
    assert [value for index, value in enumerate(after) if index not in {2, 19, 20, 21}] == [
        value for index, value in enumerate(before) if index not in {2, 19, 20, 21}
    ]
    assert [update["range"] for update in old.batch_calls[0]] == ["C2", "T2:V2"]


def test_receipt_finds_same_id_after_row_insertion(monkeypatch):
    original = allocation()
    other = allocation(item="Another purchase")
    old = ReceiptWorksheet([collaboration.SHARED_REIMBURSEMENT_HEADERS, collaboration._allocation_row(original)])
    mock_history(monkeypatch, (record(original, old),), on_read=lambda: old.insert_row(collaboration._allocation_row(other), 2))

    result = collaboration.mark_reimbursed(original.allocation_id, actor_key=BRIAN)

    assert result is not None and result.status == "reimbursed"
    assert old.get_all_values()[1] == collaboration._allocation_row(other)
    assert [update["range"] for update in old.batch_calls[0]] == ["C3", "T3:V3"]


@pytest.mark.parametrize("change", [{"partner_share": 80}, {"status": "void"}, {"received_amount": 20}])
def test_receipt_refuses_changed_allocation_after_history_selection(monkeypatch, change):
    original = allocation()
    changed = replace(original, **change)
    old = ReceiptWorksheet([collaboration.SHARED_REIMBURSEMENT_HEADERS, collaboration._allocation_row(changed)])
    mock_history(monkeypatch, (record(original, old),))

    assert collaboration.mark_reimbursed(original.allocation_id, actor_key=BRIAN) is None
    assert old.batch_calls == []


def test_repeat_receipt_preserves_original_receipt_date_and_has_no_write(monkeypatch):
    original = allocation(status="reimbursed", received_amount=100, received_at="2026-01-04T13:30:00-08:00")
    old = ReceiptWorksheet([collaboration.SHARED_REIMBURSEMENT_HEADERS, collaboration._allocation_row(original)])
    mock_history(monkeypatch, (record(original, old),))

    result = collaboration.mark_reimbursed(original.allocation_id, actor_key=BRIAN)

    assert result == original
    assert old.batch_calls == []


def test_incomplete_history_prevents_receipt_and_false_empty_queries(monkeypatch):
    original = allocation()
    old = ReceiptWorksheet([collaboration.SHARED_REIMBURSEMENT_HEADERS, collaboration._allocation_row(original)])

    def incomplete():
        raise RuntimeError("Prior-year ledger unavailable")

    mock_history(monkeypatch, (record(original, old),), complete=incomplete)
    with pytest.raises(RuntimeError, match="ledger unavailable"):
        collaboration.mark_reimbursed(original.allocation_id, actor_key=BRIAN)
    with pytest.raises(RuntimeError, match="ledger unavailable"):
        collaboration.matching_outstanding_allocations(BRIAN)
    assert old.batch_calls == []


def test_cross_year_queries_keep_payer_and_counterpart_directions(monkeypatch):
    original = allocation(split_method="fronted", payer_share=0, partner_share=200,
                          responsible_owner_key="hannah", responsible_person="Hannah")
    settled = allocation(status="reimbursed", received_amount=100)
    old = ReceiptWorksheet([])
    calls = mock_history(monkeypatch, (record(original, old), record(settled, old)))

    owed_to_brian = collaboration.matching_outstanding_allocations(BRIAN, "Safeway")
    owed_by_hannah = collaboration.matching_outstanding_obligations(HANNAH)

    assert owed_to_brian == [original]
    assert owed_by_hannah == [original]
    assert calls == [BRIAN, BRIAN]


def test_missing_or_duplicate_authoritative_id_never_updates_other_row(monkeypatch):
    original = allocation()
    old = ReceiptWorksheet([collaboration.SHARED_REIMBURSEMENT_HEADERS])
    mock_history(monkeypatch, (record(original, old),))
    assert collaboration.mark_reimbursed(original.allocation_id, actor_key=BRIAN) is None
    old.append_row(collaboration._allocation_row(original))
    old.append_row(collaboration._allocation_row(original))
    assert collaboration.mark_reimbursed(original.allocation_id, actor_key=BRIAN) is None
    assert old.batch_calls == []


def test_receipt_does_not_fall_back_to_other_owner_or_current_sheet(monkeypatch):
    original = allocation()
    repo = SheetsRepoStub(shared_reimbursements_rows=[collaboration.SHARED_REIMBURSEMENT_HEADERS,
                                                    collaboration._allocation_row(original)])
    mock_history(monkeypatch, ())
    with repo.patched():
        assert collaboration.mark_reimbursed(original.allocation_id, actor_key=HANNAH) is None
    assert repo.shared_reimbursements.update_calls == 0


def test_real_annual_history_query_receipt_and_refresh_use_same_ledger(monkeypatch):
    from bookiebot.sheets import auth, reimbursement_history

    original = allocation(created_at="2025-12-22T11:00:00-08:00", updated_at="2025-12-22T11:00:00-08:00")
    old = ReceiptWorksheet([collaboration.SHARED_REIMBURSEMENT_HEADERS, collaboration._allocation_row(original)])
    repo = SheetsRepoStub()
    now = datetime(2026, 1, 4, 13, 30, tzinfo=PACIFIC_TZ)
    monkeypatch.setattr(collaboration, "now_pacific", lambda: now)
    monkeypatch.setattr(reimbursement_history, "configured_reimbursement_workbooks",
                        lambda actor, year: {2025: "prior-budget", 2026: "current-budget"})
    monkeypatch.setattr(auth, "get_gspread_client", lambda: SimpleNamespace(
        open_by_key=lambda key: SimpleNamespace(worksheet=lambda title: old),
    ))

    with repo.patched(), sheet_user_context(BRIAN):
        matches = collaboration.matching_outstanding_allocations(BRIAN, "Groceries")
        assert matches == [original]
        received = collaboration.mark_reimbursed(matches[0].allocation_id, actor_key=BRIAN)
        assert received is not None and received.outstanding_amount == 0
        assert collaboration.matching_outstanding_allocations(BRIAN) == []
        history = reimbursement_history.read_reimbursement_history(BRIAN, as_of=now)

    assert history.status == "complete"
    assert history.records[0].year == 2025
    assert history.records[0].allocation.status == "reimbursed"
    assert repo.shared_reimbursements.get_all_values() == []
    assert len(old.batch_calls) == 1


@pytest.mark.asyncio
async def test_receipt_handler_passes_trusted_actor_and_records_older_allocation(monkeypatch):
    from bookiebot.intents import handlers

    original = allocation()
    updated = replace(original, status="reimbursed", received_amount=100)
    message = SimpleNamespace(author=SimpleNamespace(id=int(BRIAN), name="Brian"),
                              channel=SimpleNamespace(send=AsyncMock()))
    writes = []
    events = []
    monkeypatch.setattr(handlers, "matching_outstanding_allocations", lambda actor, text: [original])

    def receive(allocation_id, *, actor_key):
        writes.append((allocation_id, actor_key))
        return updated

    monkeypatch.setattr(handlers, "mark_reimbursed", receive)
    monkeypatch.setattr(handlers, "record_system_event", lambda *args: events.append(args))
    await handlers.mark_shared_reimbursement_received_handler({"match_text": "Groceries"}, message)
    assert writes == [(original.allocation_id, BRIAN)]
    assert events[0][0:2] == (BRIAN, "shared_reimbursement_received")
    assert events[0][2]["allocation_id"] == original.allocation_id
    assert "no income was logged" in message.channel.send.await_args.args[0]


@pytest.mark.asyncio
@pytest.mark.parametrize("operation", ["query", "select", "receive"])
async def test_handler_explains_incomplete_history_without_claiming_empty_or_paid(monkeypatch, operation):
    from bookiebot.intents import handlers
    from bookiebot.sheets.reimbursement_history import ReimbursementHistoryUnavailableError

    message = SimpleNamespace(author=SimpleNamespace(id=int(BRIAN), name="Brian"),
                              channel=SimpleNamespace(send=AsyncMock()))

    def unavailable(*args, **kwargs):
        raise ReimbursementHistoryUnavailableError("Cannot check old ledger")

    monkeypatch.setattr(handlers, "matching_outstanding_allocations",
                        (lambda *args: [allocation()]) if operation == "receive" else unavailable)
    monkeypatch.setattr(handlers, "mark_reimbursed", unavailable)
    monkeypatch.setattr(handlers, "record_system_event", lambda *args: pytest.fail("Cannot record a failed receipt"))
    if operation == "query":
        await handlers.query_shared_reimbursements_handler({}, message)
    else:
        await handlers.mark_shared_reimbursement_received_handler({}, message)
    text = message.channel.send.await_args.args[0]
    assert "couldn't check all reimbursement records" in text
    if operation != "query":
        assert "Nothing was marked received" in text
