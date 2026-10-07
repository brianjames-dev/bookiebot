from __future__ import annotations

import pytest
import asyncio
import threading
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import bookiebot.splits as splits
from bookiebot.splits import requested_split_directive, should_auto_prompt_for_split
from bookiebot.ui.recent_actions import CancelSplitConfirmView, ChangeSplitMethodView, SplitMethodView
from bookiebot.sheets.routing import get_current_discord_user_id


@pytest.mark.parametrize(
    ("content", "expected"),
    [
        ("paid PG&E $200 split by income", "income"),
        ("groceries $100 split evenly", "equal"),
        ("groceries $100 50/50", "equal"),
        ("I covered $100 of groceries for Hannah", "fronted"),
        ("cover this expense for Hannah", "fronted"),
        ("I fronted $100 of groceries for Hannah", "fronted"),
        ("front this expense for Hannah", "fronted"),
        ("Hannah owes me the full amount for this expense", "fronted"),
        ("log this and split", "prompt"),
        ("no split on this one", "none"),
        ("ordinary coffee purchase", None),
    ],
)
def test_requested_split_directive(content, expected):
    assert requested_split_directive({}, content) == expected


@pytest.mark.parametrize(
    ("category", "location", "payment", "expected"),
    [
        ("grocery", "Safeway", "", True),
        ("food", "Gameday", "", True),
        ("shopping", "gameday", "", True),
        ("", "", "rent", True),
        ("", "", "PG&E", True),
        ("", "", "water", True),
        ("", "", "recology", True),
        ("", "", "internet", False),
        ("food", "Chipotle", "", False),
    ],
)
def test_automatic_split_prompt_rules(category, location, payment, expected):
    assert should_auto_prompt_for_split(category=category, location=location, payment_label=payment) is expected


@pytest.mark.asyncio
async def test_split_method_buttons_use_approved_labels_and_no_split_is_secondary():
    view = SplitMethodView(lambda *_args: None)

    assert [child.label for child in view.children] == ["By income", "50/50", "Fronted", "No split"]
    assert view.children[-1].style.name == "secondary"


@pytest.mark.asyncio
async def test_split_change_and_cancel_confirmation_buttons_are_explicit():
    change_view = ChangeSplitMethodView(lambda *_args: None, can_cancel_split=True)
    cancel_view = CancelSplitConfirmView(lambda *_args: None)

    assert [child.label for child in change_view.children] == ["By income", "50/50", "Fronted", "Cancel split", "Cancel"]
    assert change_view.children[-2].style.name == "danger"
    assert change_view.children[-1].style.name == "secondary"
    assert [child.label for child in cancel_view.children] == ["Confirm cancel split", "Keep split"]
    assert cancel_view.children[0].style.name == "danger"
    assert cancel_view.children[1].style.name == "secondary"


@pytest.mark.asyncio
@pytest.mark.parametrize("method", ["income", "equal", "fronted", "cancel", "cancel_split"])
async def test_existing_split_submenu_routes_methods_and_rejects_other_owners(monkeypatch, method):
    change = MagicMock(return_value=(True, "Changed split."))
    create = MagicMock()
    cancel = AsyncMock()
    monkeypatch.setattr(splits, "change_split_recent_action", change)
    monkeypatch.setattr(splits, "split_recent_action", create)
    actor_key = "830984827904851969"
    view = splits.change_split_method_view(actor_key, "existing-split", on_cancel_split=cancel)
    button = next(child for child in view.children if child.custom_id == method)
    interaction = SimpleNamespace(
        user=SimpleNamespace(id=676638528590970917, name=".deebers"),
        response=SimpleNamespace(send_message=AsyncMock(), defer=AsyncMock()),
        followup=SimpleNamespace(send=AsyncMock()),
    )

    await button.callback(interaction)

    assert "belongs to another user" in interaction.response.send_message.call_args.args[0]
    change.assert_not_called()
    cancel.assert_not_called()
    interaction.user = SimpleNamespace(id=int(actor_key), name="hannerish")

    await button.callback(interaction)

    create.assert_not_called()
    if method == "cancel_split":
        cancel.assert_awaited_once_with(interaction)
        change.assert_not_called()
    elif method == "cancel":
        change.assert_not_called()
        cancel.assert_not_called()
        assert "existing split remains unchanged" in interaction.response.send_message.call_args.args[0]
    else:
        change.assert_called_once_with(actor_key, split_method=method, action_id="existing-split")
        cancel.assert_not_called()


@pytest.mark.asyncio
@pytest.mark.parametrize("editing", [False, True])
async def test_split_acknowledges_before_worker_and_keeps_event_loop_responsive(monkeypatch, editing):
    actor = "830984827904851969"
    loop = asyncio.get_running_loop()
    loop_thread = threading.get_ident()
    started, release = asyncio.Event(), threading.Event()
    interaction = SimpleNamespace(
        user=SimpleNamespace(id=int(actor), name="hannerish"),
        response=SimpleNamespace(defer=AsyncMock(), send_message=AsyncMock()),
        followup=SimpleNamespace(send=AsyncMock()),
    )
    context_before = get_current_discord_user_id()
    def slow_operation(*args, **kwargs):
        interaction.response.defer.assert_awaited_once_with(ephemeral=True, thinking=True)
        assert threading.get_ident() != loop_thread
        assert get_current_discord_user_id() == actor
        loop.call_soon_threadsafe(started.set)
        assert release.wait(2), "Discord's event loop did not resume during the split"
        return True, "Saved split."
    monkeypatch.setattr(splits, "change_split_recent_action" if editing else "split_recent_action", slow_operation)
    view = (splits.change_split_method_view if editing else splits.split_method_view)(actor, "source")
    task = asyncio.create_task(next(child for child in view.children if child.custom_id == "income").callback(interaction))
    try:
        await asyncio.wait_for(started.wait(), 1)
        assert not task.done()
        interaction.followup.send.assert_not_awaited()
    finally:
        release.set()
        await task
    assert "Saved split." in interaction.followup.send.call_args.args[0]
    assert interaction.followup.send.call_args.kwargs["ephemeral"] is True
    assert get_current_discord_user_id() == context_before


@pytest.mark.asyncio
@pytest.mark.parametrize("editing", [False, True])
async def test_split_worker_failure_completes_private_thinking_response(monkeypatch, editing):
    operation = MagicMock(side_effect=TimeoutError("private transport details"))
    monkeypatch.setattr(splits, "change_split_recent_action" if editing else "split_recent_action", operation)
    actor = "830984827904851969"
    interaction = SimpleNamespace(user=SimpleNamespace(id=int(actor), name="hannerish"),
        response=SimpleNamespace(defer=AsyncMock(), send_message=AsyncMock()), followup=SimpleNamespace(send=AsyncMock()))
    view = (splits.change_split_method_view if editing else splits.split_method_view)(actor, "source")
    await next(child for child in view.children if child.custom_id == "equal").callback(interaction)
    interaction.response.defer.assert_awaited_once_with(ephemeral=True, thinking=True)
    assert "Check Recent transactions and Shared" in interaction.followup.send.call_args.args[0]
    assert "private transport details" not in interaction.followup.send.call_args.args[0]


@pytest.mark.asyncio
async def test_split_failed_acknowledgment_never_starts_mutation(monkeypatch):
    operation = MagicMock()
    monkeypatch.setattr(splits, "split_recent_action", operation)
    actor = "830984827904851969"
    interaction = SimpleNamespace(user=SimpleNamespace(id=int(actor), name="hannerish"),
        response=SimpleNamespace(defer=AsyncMock(side_effect=TimeoutError())), followup=SimpleNamespace(send=AsyncMock()))
    view = splits.split_method_view(actor, "source")
    with pytest.raises(TimeoutError):
        await view.children[0].callback(interaction)
    operation.assert_not_called()


@pytest.mark.asyncio
@pytest.mark.parametrize("method", ["income", "equal", "fronted"])
async def test_explicit_split_after_log_runs_in_worker_with_owner_context(monkeypatch, method):
    actor = "830984827904851969"
    loop_thread = threading.get_ident()
    def operation(*args, **kwargs):
        assert threading.get_ident() != loop_thread
        assert get_current_discord_user_id() == actor
        assert kwargs == {"split_method": method, "action_id": "source"}
        return True, "Saved split."
    monkeypatch.setattr(splits, "split_recent_action", operation)
    message = SimpleNamespace(content="", channel=SimpleNamespace(send=AsyncMock()))
    await splits.continue_split_after_log(data={"split_method": method}, message=message, actor_key=actor, action_id="source")
    assert "Saved split." in message.channel.send.call_args.args[0]


@pytest.mark.asyncio
@pytest.mark.parametrize("same_expense", [True, False])
async def test_split_workers_serialize_one_expense_without_blocking_another(same_expense):
    actor = "830984827904851969"
    loop = asyncio.get_running_loop()
    entered, second_entered, release = asyncio.Event(), asyncio.Event(), threading.Event()
    calls = []
    def operation(_actor, *, action_id):
        calls.append(action_id)
        if len(calls) == 1:
            loop.call_soon_threadsafe(entered.set)
            assert release.wait(2)
        else:
            loop.call_soon_threadsafe(second_entered.set)
        return True, "Saved"
    first = asyncio.create_task(asyncio.to_thread(splits.run_split_operation, operation, actor, action_id="first"))
    await asyncio.wait_for(entered.wait(), 1)
    second_id = "first" if same_expense else "other"
    second = asyncio.create_task(asyncio.to_thread(splits.run_split_operation, operation, actor, action_id=second_id))
    try:
        if same_expense:
            async def queued():
                while splits._SPLIT_LOCKS.get((actor, "first"), (None, 0))[1] != 2:
                    await asyncio.sleep(0)
            await asyncio.wait_for(queued(), 1)
            assert not second_entered.is_set()
        else:
            await asyncio.wait_for(second_entered.wait(), 1)
            assert not first.done()
    finally:
        release.set()
        await asyncio.gather(first, second)
    assert len(calls) == 2
    assert (actor, "first") not in splits._SPLIT_LOCKS
    assert (actor, second_id) not in splits._SPLIT_LOCKS


def test_failed_split_worker_releases_lock_and_owner_context():
    actor = "830984827904851969"
    context_before = get_current_discord_user_id()
    with pytest.raises(TimeoutError):
        splits.run_split_operation(MagicMock(side_effect=TimeoutError()), actor, action_id="failure")
    assert (actor, "failure") not in splits._SPLIT_LOCKS
    assert get_current_discord_user_id() == context_before
