"""Delete/Undo and Discord recovery contracts against isolated sheets only."""
import asyncio
from copy import deepcopy
from types import SimpleNamespace
import threading
from unittest.mock import AsyncMock, Mock

import discord
from discord.webhook.async_ import async_context
from gspread.exceptions import APIError
import pytest

from bookiebot.intents import handlers as handlers
from bookiebot.sheets import undo
from bookiebot.sheets.routing import get_current_discord_user_id
from unit_tests.support.sheets_repo_stub import SheetsRepoStub

ACTOR = "676638528590970917"


def interaction(actor=ACTOR):
    return SimpleNamespace(user=SimpleNamespace(id=actor), response=SimpleNamespace(
        defer=AsyncMock(), send_message=AsyncMock()), followup=SimpleNamespace(send=AsyncMock()))


def quota_error():
    return APIError(SimpleNamespace(status_code=429, json=lambda: {
        "error": {"code": 429, "message": "Read quota exceeded", "status": "RESOURCE_EXHAUSTED"}}))


@pytest.fixture
def saved(monkeypatch):
    monkeypatch.setenv("BOOKIEBOT_REIMBURSEMENTS_ENABLED", "false")
    undo.clear_pending_action_selection(ACTOR)
    handlers._RECENT_PRIVATE_FOLLOWUPS.clear()
    sync = Mock()
    monkeypatch.setattr(undo, "_sync_reconciliation_after_action_mutation", sync)
    repo = SheetsRepoStub(expense_rows=[[], []])
    with repo.patched():
        columns = undo._category_columns("shopping")
        ids = []
        for row in range(3, 26):
            fields = {"date": "10/25/2026", "amount": f"${row}.00", "item": f"Isolated cable {row}",
                      "location": "Fixture shop", "person": "Brian (BofA)"}
            values = [fields[field] for field in columns]
            for column, value in zip(columns.values(), values):
                repo.expense.update_cell(row, column, value)
            ids.append(undo.record_undo_action(ACTOR, undo.UndoAction(
                worksheet="expense", kind="clear_cells", row=row, columns=list(columns.values()),
                previous_values=[""] * len(columns), new_values=values,
                metadata={"type": "expense", "category": "shopping"}, description=f"isolated expense {row}")))
        yield SimpleNamespace(repo=repo, ids=ids, columns=columns, sync=sync)
    undo.clear_pending_action_selection(ACTOR)
    handlers._RECENT_PRIVATE_FOLLOWUPS.clear()


def test_large_delete_uses_bounded_reads_and_undo_restores_rows_lineage_and_bank_links(saved, monkeypatch):
    before = deepcopy(saved.repo.expense._rows)
    reads = Mock(wraps=saved.repo.expense.get_all_values)
    monkeypatch.setattr(saved.repo.expense, "get_all_values", reads)
    monkeypatch.setattr(saved.repo.expense, "cell", Mock(side_effect=AssertionError("No per-cell API reads")))
    success, detail = undo.delete_recent_action(ACTOR, action_id=saved.ids[0])
    assert success, detail
    # One fresh deletion snapshot and one batched fallback shift (real Sheets shifts structurally).
    assert reads.call_count == 2
    assert undo.active_logged_action_by_id(ACTOR, saved.ids[0]) is None
    assert undo.active_logged_action_by_id(ACTOR, saved.ids[1]).action.row == 3
    success, detail = undo.undo_last_action(ACTOR)
    assert success, detail
    assert saved.repo.expense._rows[:len(before)] == before
    assert undo.active_logged_action_by_id(ACTOR, saved.ids[0]).action.row == 3
    assert undo.active_logged_action_by_id(ACTOR, saved.ids[1]).action.row == 4
    reasons = [call.kwargs["reason"] for call in saved.sync.call_args_list]
    assert reasons == ["deleted", "undone"]


def test_snapshot_preserves_ragged_blank_rows_and_column_order_with_one_read():
    ws = SimpleNamespace(get_all_values=Mock(return_value=[["a", "b"], [], ["c", "d", "e"]]),
                         cell=Mock(side_effect=AssertionError("No cell reads")))
    assert undo._category_snapshot(ws, range(1, 5), [3, 1]) == [["", "a"], ["", ""], ["e", "c"], ["", ""]]
    ws.get_all_values.assert_called_once_with()


@pytest.mark.parametrize("stage", ["sheet", "action_log"])
def test_quota_during_preparation_reports_no_delete_and_preserves_all_state(saved, monkeypatch, stage):
    before = deepcopy(saved.repo.expense._rows)
    log_before = deepcopy(saved.repo.action_log._rows)
    sheet = saved.repo.expense if stage == "sheet" else saved.repo.action_log
    monkeypatch.setattr(sheet, "get_all_values", Mock(side_effect=quota_error()))
    success, detail = undo.delete_recent_action(ACTOR, action_id=saved.ids[0])
    assert not success and "rate-limiting" in detail and "Nothing was deleted" in detail
    assert saved.repo.expense._rows == before
    assert saved.repo.action_log._rows == log_before
    saved.sync.assert_not_called()


def test_changed_source_and_stale_pending_selection_cannot_delete_another_row(saved):
    undo.set_pending_delete_selection(ACTOR, saved.ids[0])
    undo._mark_undone(saved.ids[0])
    before = deepcopy(saved.repo.expense._rows)
    assert not undo.delete_recent_action(ACTOR, index=1)[0]
    assert saved.repo.expense._rows == before
    undo.clear_pending_action_selection(ACTOR)
    saved.repo.expense.update_cell(4, saved.columns["amount"], "$999.00")
    before = deepcopy(saved.repo.expense._rows)
    success, detail = undo.delete_recent_action(ACTOR, action_id=saved.ids[1])
    assert not success and "changed" in detail and "Nothing was deleted" in detail
    assert saved.repo.expense._rows == before


def test_failure_after_write_is_uncertain_and_never_claims_nothing_changed(saved, monkeypatch):
    def write_then_fail(*args, **kwargs):
        saved.repo.expense.update_cell(3, saved.columns["amount"], "$888.00")
        raise TimeoutError("lost write response")
    monkeypatch.setattr(undo, "_shift_category_cells_up", write_then_fail)
    success, detail = undo.delete_recent_action(ACTOR, action_id=saved.ids[0])
    assert not success and "could not verify" in detail
    assert "Nothing was deleted" not in detail


@pytest.mark.asyncio
@pytest.mark.parametrize("more", [False, True])
async def test_recent_read_failure_is_not_reported_as_an_empty_history(saved, monkeypatch, more):
    monkeypatch.setattr(saved.repo.action_log, "get_all_values", Mock(side_effect=quota_error()))
    send = AsyncMock()
    monkeypatch.setattr(handlers, "_send_recent_private_message", send)
    message = SimpleNamespace(author=SimpleNamespace(id=ACTOR))
    undo.reset_recent_actions_page(ACTOR, 5)
    await handlers.query_recent_actions_handler({"more": more}, message)
    assert "rate-limiting" in send.call_args.args[1]
    assert "type `recent` again" in send.call_args.args[1]
    assert "no recent logged" not in send.call_args.args[1].lower()
    assert undo._RECENT_ACTION_OFFSET_BY_USER[ACTOR] == 5


@pytest.mark.asyncio
@pytest.mark.parametrize("chunks", [["No entries"], ["First page", "Last page"]])
async def test_empty_recent_followups_serialize_with_real_discord_and_no_none_view(monkeypatch, chunks):
    adapter = SimpleNamespace(execute_webhook=AsyncMock(return_value={"id": "789"}))
    webhook = discord.Webhook({"id": "123", "type": 3, "token": "fixture-token"},
                              session=SimpleNamespace(), state=SimpleNamespace(store_view=Mock()))
    monkeypatch.setattr(discord.Webhook, "_create_message", lambda *_a, **_kw: SimpleNamespace(id=789))
    token = async_context.set(adapter)
    try:
        await handlers._send_recent_followup_chunks(webhook.send, chunks, {"view": None})
    finally:
        async_context.reset(token)
    assert adapter.execute_webhook.await_count == len(chunks)
    for call in adapter.execute_webhook.call_args_list:
        assert "components" not in call.kwargs["payload"]
        assert call.kwargs["payload"]["flags"] & 64


async def decision_view(saved, monkeypatch):
    logged = undo.select_recent_action(ACTOR, action_id=saved.ids[0])
    monkeypatch.setattr(handlers, "select_recent_action", Mock(return_value=logged))
    selection = handlers._recent_action_select_view(ACTOR, [logged]).children[0]
    selected = interaction()
    await selection.callback_func(selected, logged.id)
    return selected.followup.send.call_args.kwargs["view"]


@pytest.mark.asyncio
async def test_delete_acks_before_worker_uses_actor_context_exact_id_and_rejects_double_click(saved, monkeypatch):
    view = await decision_view(saved, monkeypatch)
    control = next(child for child in view.children if child.custom_id == "delete")
    clicked = interaction()
    loop_thread = threading.get_ident()
    started, release = threading.Event(), threading.Event()
    def delete(actor, *, action_id):
        clicked.response.defer.assert_awaited_once_with(ephemeral=True, thinking=True)
        assert threading.get_ident() != loop_thread
        assert get_current_discord_user_id() == ACTOR
        assert actor == ACTOR and action_id == saved.ids[0]
        started.set()
        assert release.wait(3)
        return True, "Deleted isolated fixture"
    writer = Mock(side_effect=delete)
    monkeypatch.setattr(handlers, "delete_recent_action", writer)
    task = asyncio.create_task(control.callback(clicked))
    try:
        assert await asyncio.to_thread(started.wait, 2)
        duplicate = interaction()
        await control.callback(duplicate)
        assert "already requested" in duplicate.followup.send.call_args.args[0]
        assert writer.call_count == 1
    finally:
        release.set()
    await task
    assert "Deleted isolated fixture" in clicked.followup.send.call_args.args[0]


@pytest.mark.asyncio
@pytest.mark.parametrize("flow", ["decision", "confirm"])
async def test_expired_ack_and_foreign_owner_never_call_delete(saved, monkeypatch, flow):
    if flow == "decision":
        view = await decision_view(saved, monkeypatch)
        control = next(child for child in view.children if child.custom_id == "delete")
    else:
        control = handlers._delete_confirm_view(ACTOR, saved.ids[0]).children[0]
    writer = Mock()
    monkeypatch.setattr(handlers, "delete_recent_action", writer)
    foreign = interaction("830984827904851969")
    await control.callback(foreign)
    foreign.response.defer.assert_not_awaited()
    foreign.response.send_message.assert_awaited_once()
    expired = interaction()
    expired.response.defer.side_effect = RuntimeError("Expired interaction")
    await control.callback(expired)
    writer.assert_not_called()


@pytest.mark.asyncio
async def test_selection_acknowledges_before_io_and_missing_row_has_no_controls(saved, monkeypatch):
    clicked = interaction()
    loop_thread = threading.get_ident()
    def load(*_a, **_kw):
        clicked.response.defer.assert_awaited_once_with(ephemeral=True, thinking=True)
        assert threading.get_ident() != loop_thread
        return None
    monkeypatch.setattr(handlers, "select_recent_action", load)
    selection = handlers._recent_action_select_view(ACTOR, []).children[0]
    await selection.callback_func(clicked, "missing")
    assert "no longer available" in clicked.followup.send.call_args.args[0]
    assert "view" not in clicked.followup.send.call_args.kwargs


@pytest.mark.asyncio
async def test_unknown_delete_result_does_not_resubmit_or_claim_unchanged(saved, monkeypatch):
    callback = handlers._recent_delete_callback(ACTOR, saved.ids[0])
    writer = Mock(side_effect=TimeoutError("write response lost"))
    monkeypatch.setattr(handlers, "delete_recent_action", writer)
    clicked = interaction()
    await callback(clicked)
    assert "could not verify" in clicked.followup.send.call_args.args[0]
    assert "Nothing was deleted" not in clicked.followup.send.call_args.args[0]
    await callback(interaction())
    assert writer.call_count == 1


@pytest.mark.asyncio
async def test_two_views_of_the_same_delete_create_one_undo_and_leave_neighbors(saved):
    before = deepcopy(saved.repo.expense._rows)
    one = handlers._recent_delete_callback(ACTOR, saved.ids[0])
    two = handlers._recent_delete_callback(ACTOR, saved.ids[0])
    replies = [interaction(), interaction()]
    await asyncio.gather(one(replies[0]), two(replies[1]))
    assert sum("✅ Deleted:" in reply.followup.send.call_args.args[0] for reply in replies) == 1
    assert len([row for row in saved.repo.action_log._rows[1:] if '"compact_category_cells"' in row[5]]) == 1
    assert undo.active_logged_action_by_id(ACTOR, saved.ids[1]).action.row == 3
    assert undo.undo_last_action(ACTOR)[0]
    assert saved.repo.expense._rows[:len(before)] == before


@pytest.mark.asyncio
@pytest.mark.parametrize("targets", [(0, 1), (1, 0), (0, 2)])
async def test_overlapping_deletes_reload_shifted_rows_and_both_undos_restore_history(saved, monkeypatch, targets):
    before = deepcopy(saved.repo.expense._rows)
    original = undo._shift_category_cells_up
    entered, release = threading.Event(), threading.Event()
    calls = 0
    def shift(*args, **kwargs):
        nonlocal calls
        calls += 1
        if calls == 1:
            entered.set()
            assert release.wait(3)
        return original(*args, **kwargs)
    monkeypatch.setattr(undo, "_shift_category_cells_up", shift)
    task = asyncio.create_task(handlers._recent_delete_callback(ACTOR, saved.ids[targets[0]])(interaction()))
    try:
        assert await asyncio.to_thread(entered.wait, 2)
        other = asyncio.create_task(handlers._recent_delete_callback(ACTOR, saved.ids[targets[1]])(interaction()))
        await asyncio.sleep(0)
    finally:
        release.set()
    await asyncio.gather(task, other)
    assert calls == 2
    assert undo.active_logged_action_by_id(ACTOR, saved.ids[targets[0]]) is None
    assert undo.active_logged_action_by_id(ACTOR, saved.ids[targets[1]]) is None
    first_remaining = next(identity for index, identity in enumerate(saved.ids) if index not in targets)
    assert undo.active_logged_action_by_id(ACTOR, first_remaining).action.row == 3
    assert undo.undo_last_action(ACTOR)[0]
    assert undo.undo_last_action(ACTOR)[0]
    assert saved.repo.expense._rows[:len(before)] == before


@pytest.mark.asyncio
@pytest.mark.parametrize("quota", [False, True])
async def test_empty_or_failed_recent_launcher_renders_real_private_payload(saved, monkeypatch, quota):
    if quota:
        monkeypatch.setattr(saved.repo.action_log, "get_all_values", Mock(side_effect=quota_error()))
    else:
        saved.repo.action_log._rows = []
    dm = SimpleNamespace(delete=AsyncMock())
    author = SimpleNamespace(id=ACTOR, send=AsyncMock(return_value=dm))
    message = SimpleNamespace(author=author, channel=SimpleNamespace(guild=None, send=AsyncMock()))
    await handlers.query_recent_actions_handler({}, message)
    launcher = author.send.call_args.kwargs["view"]
    adapter = SimpleNamespace(execute_webhook=AsyncMock(return_value={"id": "789"}))
    webhook = discord.Webhook({"id": "123", "type": 3, "token": "fixture-token"},
                              session=SimpleNamespace(), state=SimpleNamespace(store_view=Mock()))
    monkeypatch.setattr(discord.Webhook, "_create_message", lambda *_a, **_kw: SimpleNamespace(id=789))
    token = async_context.set(adapter)
    clicked = interaction()
    clicked.followup = webhook
    clicked.message = dm
    try:
        await launcher.children[0].callback(clicked)
    finally:
        async_context.reset(token)
    clicked.response.defer.assert_awaited_once_with(ephemeral=True, thinking=True)
    payload = adapter.execute_webhook.call_args.kwargs["payload"]
    assert ("rate-limiting" if quota else "not have any recent logged") in payload["content"]
    assert "components" not in payload
    assert payload["flags"] & 64
    dm.delete.assert_awaited_once()


@pytest.mark.asyncio
async def test_lost_delete_reply_does_not_repeat_the_writer(saved, monkeypatch):
    callback = handlers._recent_delete_callback(ACTOR, saved.ids[0])
    writer = Mock(return_value=(True, "Deleted fixture"))
    monkeypatch.setattr(handlers, "delete_recent_action", writer)
    clicked = interaction()
    clicked.followup.send.side_effect = TimeoutError("lost reply")
    with pytest.raises(TimeoutError):
        await callback(clicked)
    retry = interaction()
    await callback(retry)
    writer.assert_called_once_with(ACTOR, action_id=saved.ids[0])
    assert "already requested" in retry.followup.send.call_args.args[0]


def test_delete_with_failed_undo_persistence_is_explicit_and_cannot_delete_next_row(saved, monkeypatch):
    monkeypatch.setattr(undo, "record_undo_action", Mock(return_value=None))
    success, detail = undo.delete_recent_action(ACTOR, action_id=saved.ids[0])
    assert not success and "could not save its Undo record" in detail
    before = deepcopy(saved.repo.expense._rows)
    assert not undo.delete_recent_action(ACTOR, action_id=saved.ids[0])[0]
    assert saved.repo.expense._rows == before


@pytest.mark.asyncio
@pytest.mark.parametrize("flow", ["decision", "confirm"])
async def test_cancel_invalidates_delete_control_without_writing(saved, monkeypatch, flow):
    view = (await decision_view(saved, monkeypatch) if flow == "decision"
            else handlers._delete_confirm_view(ACTOR, saved.ids[0]))
    writer = Mock()
    monkeypatch.setattr(handlers, "delete_recent_action", writer)
    await next(child for child in view.children if child.custom_id == "cancel").callback(interaction())
    clicked = interaction()
    await next(child for child in view.children if child.custom_id in {"delete", "confirm_delete"}).callback(clicked)
    assert "was canceled" in clicked.followup.send.call_args.args[0]
    writer.assert_not_called()


def test_successive_adjacent_deletes_retain_relative_restore_gaps_after_prior_compactions(saved):
    before = deepcopy(saved.repo.expense._rows)
    for index in (2, 0, 1, 3):
        success, detail = undo.delete_recent_action(ACTOR, action_id=saved.ids[index])
        assert success, detail
    for _ in range(4):
        success, detail = undo.undo_last_action(ACTOR)
        assert success, detail
    assert saved.repo.expense._rows[:len(before)] == before
