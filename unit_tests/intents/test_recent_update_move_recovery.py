"""Update/Move acceptance uses local grids and mocked Discord, never real transactions."""
import asyncio
from copy import deepcopy
from types import SimpleNamespace
import threading
from unittest.mock import AsyncMock, Mock

import pytest

from bookiebot.intents import handlers
from bookiebot.sheets import undo
from bookiebot.sheets.routing import get_current_discord_user_id
from unit_tests.intents.test_recent_delete_recovery import ACTOR, interaction, quota_error, saved as saved


def edit(operation, action_id, **kwargs):
    if operation == "Update":
        return undo.update_recent_action(ACTOR, action_id=action_id, updates=kwargs or {"amount": 44})
    return undo.move_recent_action(ACTOR, action_id=action_id, destination_category="food", updates=kwargs)


def source_grid(saved):
    return undo._category_snapshot(saved.repo.expense, range(3, 26), list(saved.columns.values()))


@pytest.mark.parametrize("operation,reads", [("Update", 1), ("Move", 2)])
def test_one_snapshot_prepares_edit_and_preserves_undo_lineage_and_bank_links(saved, monkeypatch, operation, reads):
    before = source_grid(saved)
    bulk = Mock(wraps=saved.repo.expense.get_all_values)
    monkeypatch.setattr(saved.repo.expense, "get_all_values", bulk)
    monkeypatch.setattr(saved.repo.expense, "cell", Mock(side_effect=AssertionError("No per-cell reads")))
    success, detail = edit(operation, saved.ids[0])
    assert success, detail
    # The extra Move read is only the in-memory stub's bulk compaction fallback;
    # production uses a structural Sheets request rather than reading neighbors.
    assert bulk.call_count == reads
    latest = undo.recent_actions(ACTOR, 1)[0]
    assert latest.action.metadata["type"] == operation.lower()
    assert undo.undo_last_action(ACTOR)[0]
    assert source_grid(saved) == before
    assert undo.active_logged_action_by_id(ACTOR, saved.ids[0]).action.row == 3
    assert undo.active_logged_action_by_id(ACTOR, saved.ids[1]).action.row == 4
    assert [call.kwargs["reason"] for call in saved.sync.call_args_list] == [{"Update": "updated", "Move": "moved"}[operation], "undone"]


def test_successive_partial_updates_keep_full_display_and_undo_each_original_value(saved):
    assert edit("Update", saved.ids[0], amount=44)[0]
    first = undo.recent_actions(ACTOR, 1)[0]
    assert edit("Update", first.id, location="Second fixture shop", amount=55)[0]
    first_changed = undo.select_recent_action(ACTOR, action_id=first.id)
    fields = undo._field_values_for_action(first_changed.action)
    assert fields["date"] == "10/25/2026"
    assert fields["item"] == "Isolated cable 3"
    assert fields["amount"] == "55"
    assert fields["location"] == "Second fixture shop"
    assert undo.undo_last_action(ACTOR)[0]
    fields = undo._field_values_for_action(undo.select_recent_action(ACTOR, action_id=first.id).action)
    assert fields["amount"] == "$44.00" and fields["location"] == "Fixture shop"
    assert undo.undo_last_action(ACTOR)[0]
    assert undo._field_values_for_action(undo.select_recent_action(ACTOR, action_id=saved.ids[0]).action)["amount"] == "$3.00"
    assert saved.repo.expense.cell(3, saved.columns["amount"]).value == "$3.00"


def test_update_move_update_and_three_undos_keep_source_and_neighbors(saved):
    before = source_grid(saved)
    assert edit("Update", saved.ids[0], amount=44)[0]
    assert edit("Move", undo.recent_actions(ACTOR, 1)[0].id)[0]
    moved = undo.recent_actions(ACTOR, 1)[0]
    assert edit("Update", moved.id, location="Updated at destination")[0]
    for _ in range(3):
        success, detail = undo.undo_last_action(ACTOR)
        assert success, detail
    assert source_grid(saved) == before
    assert undo.active_logged_action_by_id(ACTOR, saved.ids[0]).action.row == 3


@pytest.mark.parametrize("operation", ["Update", "Move"])
@pytest.mark.parametrize("stage", ["sheet", "selection_log", "preparation_log"])
def test_quota_prewrite_is_visible_and_preserves_every_financial_cell_and_history(saved, monkeypatch, operation, stage):
    sheet_before = deepcopy(saved.repo.expense._rows)
    log_before = deepcopy(saved.repo.action_log._rows)
    ws = saved.repo.expense if stage == "sheet" else saved.repo.action_log
    read = ws.get_all_values
    calls = 0

    def fail():
        nonlocal calls
        calls += 1
        if stage != "preparation_log" or calls > 1:
            raise quota_error()
        return read()

    monkeypatch.setattr(ws, "get_all_values", fail)
    success, detail = edit(operation, saved.ids[0])
    assert not success and "rate-limiting" in detail and "Nothing was changed" in detail
    assert saved.repo.expense._rows == sheet_before
    assert saved.repo.action_log._rows == log_before
    saved.sync.assert_not_called()


@pytest.mark.parametrize("operation", ["Update", "Move"])
def test_stale_saved_candidate_and_out_of_range_never_fall_back_to_another_transaction(saved, operation):
    setter = undo.set_pending_update_selection if operation == "Update" else undo.set_pending_move_selection
    setter(ACTOR, saved.ids[0])
    undo._mark_undone(saved.ids[0])
    before = deepcopy(saved.repo.expense._rows)
    kwargs = {"updates": {"amount": 44}} if operation == "Update" else {"destination_category": "food"}
    writer = undo.update_recent_action if operation == "Update" else undo.move_recent_action
    for index in [1, 2]:
        success, detail = writer(ACTOR, index=index, **kwargs)
        assert not success and "no longer available" in detail
        assert saved.repo.expense._rows == before


@pytest.mark.parametrize("operation", ["Update", "Move"])
def test_unknown_write_outcome_is_not_reported_as_no_change_or_blindly_retried(saved, monkeypatch, operation):
    def write_then_fail(*_args, **_kwargs):
        saved.repo.expense.update_cell(3, saved.columns["amount"], "$888.00")
        raise TimeoutError("lost response after write")
    monkeypatch.setattr(undo, "_update_contiguous_row", write_then_fail)
    success, detail = edit(operation, saved.ids[0])
    assert not success and "could not verify" in detail and "Undo" in detail
    assert "Nothing was changed" not in detail


@pytest.mark.parametrize("operation", ["Update", "Move"])
def test_failed_undo_persistence_is_reported_accurately_after_edit(saved, monkeypatch, operation):
    monkeypatch.setattr(undo, "record_undo_action", Mock(return_value=None))
    success, detail = edit(operation, saved.ids[0])
    assert not success and "could not save its Undo record" in detail
    assert "Nothing was changed" not in detail
    saved.sync.assert_called_once()


async def open_decision(saved):
    logged = undo.select_recent_action(ACTOR, action_id=saved.ids[0])
    selected = interaction()
    await handlers._recent_action_select_view(ACTOR, [logged]).children[0].callback_func(selected, logged.id)
    return selected.followup.send.call_args.kwargs["view"]


@pytest.mark.asyncio
@pytest.mark.parametrize("operation", ["Update", "Move"])
async def test_menu_reads_ack_first_are_offloop_and_owner_scoped(saved, monkeypatch, operation):
    decision = await open_decision(saved)
    click = interaction()
    loop_thread = threading.get_ident()
    original = handlers.select_recent_action
    def load(*args, **kwargs):
        assert click.response.defer.await_count == 1
        assert threading.get_ident() != loop_thread
        assert get_current_discord_user_id() == ACTOR
        assert kwargs["strict"] is True
        return original(*args, **kwargs)
    read = Mock(side_effect=load)
    monkeypatch.setattr(handlers, "select_recent_action", read)
    await next(child for child in decision.children if child.label == operation).callback(click)
    click.response.defer.assert_awaited_once_with(ephemeral=True, thinking=True)
    assert click.followup.send.call_args.kwargs["ephemeral"] is True
    assert read.call_count == 1  # No hidden reads constructing category/field views.
    if operation == "Move":
        assert "Shopping" not in [child.label for child in click.followup.send.call_args.kwargs["view"].children]


@pytest.mark.asyncio
@pytest.mark.parametrize("operation", ["Update", "Move"])
@pytest.mark.parametrize("failure", ["quota", "missing", "ack", "owner"])
async def test_menu_failures_never_offer_unsafe_controls(saved, monkeypatch, operation, failure):
    decision = await open_decision(saved)
    read = Mock(side_effect=quota_error()) if failure == "quota" else Mock(return_value=None)
    monkeypatch.setattr(handlers, "select_recent_action", read)
    click = interaction("another-person" if failure == "owner" else ACTOR)
    if failure == "ack":
        click.response.defer.side_effect = RuntimeError("expired ACK")
    await next(child for child in decision.children if child.label == operation).callback(click)
    if failure in {"ack", "owner"}:
        read.assert_not_called()
    else:
        result = click.followup.send.call_args
        assert "view" not in result.kwargs and result.kwargs["ephemeral"] is True
        assert "rate-limiting" in result.args[0] if failure == "quota" else "no longer available" in result.args[0]


def mutation_control(operation, action_id, *, state=None):
    return handlers._recent_mutation_callback(ACTOR, action_id, operation, state=state,
        **({"updates": {"person": "Brian (AL)"}} if operation == "Update" else {"destination_category": "food"}))


@pytest.mark.asyncio
@pytest.mark.parametrize("operation", ["Update", "Move"])
async def test_mutation_ack_first_offloop_context_and_single_submission(saved, monkeypatch, operation):
    loop_thread = threading.get_ident()
    click = interaction()
    def write(actor, **kwargs):
        assert click.response.defer.await_count == 1
        assert threading.get_ident() != loop_thread
        assert get_current_discord_user_id() == ACTOR == actor
        assert kwargs["action_id"] == saved.ids[0]
        return True, "Saved fixture"
    writer = Mock(side_effect=write)
    monkeypatch.setattr(handlers, operation.lower() + "_recent_action", writer)
    callback = mutation_control(operation, saved.ids[0])
    await callback(click)
    click.response.defer.assert_awaited_once_with(ephemeral=True, thinking=True)
    assert "Saved fixture" in click.followup.send.call_args.args[0]
    assert click.followup.send.call_args.kwargs["ephemeral"] is True
    again = interaction()
    await callback(again)
    assert writer.call_count == 1 and "already requested" in again.followup.send.call_args.args[0]


@pytest.mark.asyncio
@pytest.mark.parametrize("operation", ["Update", "Move"])
@pytest.mark.parametrize("failure", ["ack", "owner", "write", "response"])
async def test_mutation_failure_and_lost_response_do_not_repeat_writer(saved, monkeypatch, operation, failure):
    writer = Mock(return_value=(True, "Saved fixture"))
    if failure == "write":
        writer.side_effect = TimeoutError("unknown result")
    monkeypatch.setattr(handlers, operation.lower() + "_recent_action", writer)
    callback = mutation_control(operation, saved.ids[0])
    click = interaction("another-person" if failure == "owner" else ACTOR)
    if failure == "ack":
        click.response.defer.side_effect = RuntimeError("expired ACK")
    if failure == "response":
        click.followup.send.side_effect = RuntimeError("lost followup")
        with pytest.raises(RuntimeError, match="lost followup"):
            await callback(click)
    else:
        await callback(click)
    if failure in {"ack", "owner"}:
        writer.assert_not_called()
    else:
        again = interaction()
        await callback(again)
        assert writer.call_count == 1 and "already requested" in again.followup.send.call_args.args[0]
        if failure == "write":
            assert "could not verify" in click.followup.send.call_args.args[0]


@pytest.mark.asyncio
@pytest.mark.parametrize("operation", ["Update", "Move"])
async def test_cancel_parent_invalidates_opened_person_or_category_view(saved, monkeypatch, operation):
    decision = await open_decision(saved)
    menu = interaction()
    await next(child for child in decision.children if child.label == operation).callback(menu)
    view = menu.followup.send.call_args.kwargs["view"]
    if operation == "Update":
        person = interaction()
        await next(child for child in view.children if child.label == "Person").callback(person)
        view = person.response.send_message.call_args.kwargs["view"]
    cancel = interaction()
    await next(child for child in decision.children if child.label == "Cancel").callback(cancel)
    writer = Mock(return_value=(True, "should never run"))
    monkeypatch.setattr(handlers, operation.lower() + "_recent_action", writer)
    click = interaction()
    await view.children[0].callback_func(click, "Brian (AL)" if operation == "Update" else "food")
    writer.assert_not_called()
    assert "canceled" in click.followup.send.call_args.args[0]


@pytest.mark.asyncio
@pytest.mark.parametrize("operation", ["Update", "Move"])
async def test_text_mutations_including_pending_replies_run_offloop_in_actor_context(saved, monkeypatch, operation):
    loop_thread = threading.get_ident()
    def write(actor, **kwargs):
        assert threading.get_ident() != loop_thread and get_current_discord_user_id() == ACTOR
        assert actor == ACTOR and kwargs["action_id"] == saved.ids[0]
        return True, "Saved fixture"
    monkeypatch.setattr(handlers, operation.lower() + "_recent_action", Mock(side_effect=write))
    send = AsyncMock()
    monkeypatch.setattr(handlers, "_send_recent_private_message", send)
    message = SimpleNamespace(author=SimpleNamespace(id=ACTOR))
    entities = {"action_id": saved.ids[0], "updates": {"amount": 44}, "category": "food"}
    await getattr(handlers, operation.lower() + "_recent_action_handler")(entities, message)
    assert "Saved fixture" in send.call_args.args[1]


@pytest.mark.asyncio
@pytest.mark.parametrize("operation", ["Update", "Move"])
@pytest.mark.parametrize("entities", [{}, {"match_text": "cable"}])
async def test_text_history_quota_is_not_presented_as_no_results(saved, monkeypatch, operation, entities):
    monkeypatch.setattr(saved.repo.action_log, "get_all_values", Mock(side_effect=quota_error()))
    send = AsyncMock()
    monkeypatch.setattr(handlers, "_send_recent_private_message", send)
    message = SimpleNamespace(author=SimpleNamespace(id=ACTOR))
    await getattr(handlers, operation.lower() + "_recent_action_handler")(entities, message)
    assert "rate-limiting" in send.call_args.args[1]
    assert "Nothing was changed" in send.call_args.args[1]


@pytest.mark.asyncio
async def test_overlapping_move_and_update_wait_for_compaction_and_undo_restores_both(saved, monkeypatch):
    before = source_grid(saved)
    entered, release, updating = threading.Event(), threading.Event(), threading.Event()
    original = undo._shift_category_cells_up
    def shift(*args, **kwargs):
        entered.set()
        assert release.wait(5)
        return original(*args, **kwargs)
    monkeypatch.setattr(undo, "_shift_category_cells_up", shift)
    move = asyncio.create_task(asyncio.to_thread(edit, "Move", saved.ids[0]))
    assert await asyncio.to_thread(entered.wait, 5)
    original_select = undo.select_recent_action
    def selected(*args, **kwargs):
        if kwargs.get("action_id") == saved.ids[1]:
            updating.set()
        return original_select(*args, **kwargs)
    monkeypatch.setattr(undo, "select_recent_action", selected)
    update = asyncio.create_task(asyncio.to_thread(edit, "Update", saved.ids[1]))
    try:
        assert not await asyncio.to_thread(updating.wait, .1)
    finally:
        release.set()
    assert (await move)[0] and (await update)[0]
    assert saved.repo.expense.cell(3, saved.columns["amount"]).value == "$44.00"
    assert undo.undo_last_action(ACTOR)[0]
    assert undo.undo_last_action(ACTOR)[0]
    assert source_grid(saved) == before


@pytest.mark.parametrize("operations", [("Move", "Move"), ("Delete", "Move"), ("Move", "Delete")])
def test_adjacent_compactions_then_lifo_undo_preserve_original_row_order(saved, operations):
    before = source_grid(saved)
    for operation, action_id in zip(operations, saved.ids[:2]):
        result = undo.delete_recent_action(ACTOR, action_id=action_id) if operation == "Delete" else edit("Move", action_id)
        assert result[0], result[1]
    for _ in operations:
        result = undo.undo_last_action(ACTOR)
        assert result[0], result[1]
    assert source_grid(saved) == before


@pytest.mark.asyncio
@pytest.mark.parametrize("entry", ["Update candidate", "Move candidate", "Update confirm", "Move confirm"])
async def test_candidate_and_confirmation_menu_reads_ack_before_offloop_work(saved, monkeypatch, entry):
    logged = undo.select_recent_action(ACTOR, action_id=saved.ids[0])
    click = interaction()
    loop_thread = threading.get_ident()
    def read(*args, **kwargs):
        assert threading.get_ident() != loop_thread and get_current_discord_user_id() == ACTOR
        assert click.response.defer.await_count == 1 and kwargs["strict"] is True
        return logged
    loader = Mock(side_effect=read)
    monkeypatch.setattr(handlers, "select_recent_action", loader)
    operation, kind = entry.split()
    view = getattr(handlers, f"_{operation.lower()}_action_select_view")(ACTOR, [logged]) if kind == "candidate" else getattr(handlers, f"_{operation.lower()}_confirm_view")(ACTOR, logged.id)
    await view.children[0].callback_func(click, logged.id if kind == "candidate" else "confirm_" + operation.lower())
    loader.assert_called_once()
    click.response.defer.assert_awaited_once_with(ephemeral=True, thinking=True)
    assert click.followup.send.call_args.kwargs["ephemeral"] is True


@pytest.mark.asyncio
@pytest.mark.parametrize("entry", ["person", "category", "move_confirm", "selection_destination"])
async def test_every_mutating_component_uses_guarded_worker_and_native_discord_payload(saved, monkeypatch, entry):
    import discord
    from discord.webhook.async_ import async_context

    logged = undo.select_recent_action(ACTOR, action_id=saved.ids[0])
    operation = "Update" if entry == "person" else "Move"
    writer = Mock(return_value=(True, "Saved isolated transaction"))
    monkeypatch.setattr(handlers, operation.lower() + "_recent_action", writer)
    if entry == "person":
        field = interaction()
        await handlers._update_field_view(ACTOR, logged.id, ["person"]).children[0].callback(field)
        view = field.response.send_message.call_args.kwargs["view"]
        value = "Brian (AL)"
    elif entry == "category":
        view = handlers._move_category_view(ACTOR, logged.id, source_category="shopping")
        value = "food"
    elif entry == "move_confirm":
        view = handlers._move_confirm_view(ACTOR, logged.id, destination_category="food")
        value = "confirm_move"
    else:
        view = handlers._recent_action_select_view(ACTOR, [logged], destination_category="food")
        value = logged.id
    # Exercise actual discord.py component and followup serialization, without HTTP.
    adapter = SimpleNamespace(execute_webhook=AsyncMock(return_value={"id": "789"}))
    webhook = discord.Webhook({"id": "123", "type": 3, "token": "fixture-token"},
        session=SimpleNamespace(), state=SimpleNamespace(store_view=Mock()))
    monkeypatch.setattr(discord.Webhook, "_create_message", lambda *_a, **_kw: SimpleNamespace(id=789))
    token = async_context.set(adapter)
    try:
        await webhook.send("Isolated menu", view=view, ephemeral=True)
        click = interaction()
        click.followup.send = webhook.send
        await view.children[0].callback_func(click, value)
        await view.children[0].callback_func(interaction(), value)
    finally:
        async_context.reset(token)
    writer.assert_called_once()
    assert writer.call_args.kwargs["action_id"] == logged.id
    assert adapter.execute_webhook.await_count == 2
    assert adapter.execute_webhook.call_args_list[0].kwargs["payload"]["components"]
    assert all(call.kwargs["payload"]["flags"] & 64 for call in adapter.execute_webhook.call_args_list)
