"""Real receipt ledger and Discord controls, with no production or sheet writes."""
import asyncio
from dataclasses import replace
from datetime import timedelta
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest

from bookiebot.core import bank_reconciliation as digest, bank_reconciliation_flow as flow
from bookiebot.core import bank_reconciliation_receipts as receipts
from bookiebot.banking.reconciliation import ActionLogCandidate, ActionLogCandidateGroup
from bookiebot.reimbursements import projection, service
from bookiebot.reimbursements.store import ReimbursementStore
from bookiebot.sheets.routing import now_pacific
from unit_tests.core.test_bank_reconciliation_flow import item
from unit_tests.core.test_bank_reconciliation import discord_followup  # noqa: F401
from unit_tests.reimbursements.test_store import access, payload, payment  # noqa: F401

ACTOR = "676638528590970917"


def interaction(actor=ACTOR):
    return SimpleNamespace(user=SimpleNamespace(id=actor), response=SimpleNamespace(
        send_message=AsyncMock(), defer=AsyncMock(), send_modal=AsyncMock()),
        followup=SimpleNamespace(send=AsyncMock()))


def text(reply):
    return "\n".join(call.kwargs.get("content", call.args[0] if call.args else "")
                     for call in reply.followup.send.call_args_list)


def view(reply):
    return next(call.kwargs["view"] for call in reversed(reply.followup.send.call_args_list) if "view" in call.kwargs)


def button(reply, action):
    return next(child for child in view(reply).children if getattr(child, "action", None) == action)


@pytest.fixture
def setup(access, monkeypatch):
    store = ReimbursementStore(access)
    store.initialize()
    today = now_pacific().date()
    row = store.register_allocation(payload(expenseDate=today.isoformat(), sourceYear=today.year,
        sourceSheetTitle=today.strftime("%B"), sourceWorksheet="income", grossCents=12500,
        payerShareCents=8091, partnerShareCents=4409))
    store.mark_projected(row["id"], row["version"])
    bank = replace(item(1), status="confirmed", matched_action_log_id=row["sourceActionId"],
        transaction=replace(item(1).transaction, amount=125, date=today.isoformat()))
    values = {1: bank}
    lookup = Mock(side_effect=lambda owner, identity: values.get(identity) if owner == "brian" else None)
    bank_service = SimpleNamespace(get_reconciliation_item=lookup,
        store=SimpleNamespace(review_reconciliation_items=Mock(side_effect=lambda *args, **kwargs: list(values.values()))))
    monkeypatch.setattr(receipts, "build_banking_service", lambda: bank_service)
    monkeypatch.setattr(service, "build_reimbursement_store", lambda: store)
    monkeypatch.setenv("BOOKIEBOT_REIMBURSEMENTS_ENABLED", "true")
    def sync(store):
        for current in store.pending_projections():
            store.mark_projected(current["id"], current["version"])
        return True
    monkeypatch.setattr(projection, "sync_pending", sync)
    return SimpleNamespace(store=store, row=row, bank=bank, values=values, bank_service=bank_service)


async def review(setup):
    reply = interaction()
    await receipts.send_bank_receipt_review(reply, owner="brian", actor=ACTOR, identity=1)
    return reply


async def confirm_review(setup, amount="12.34", when=None):
    reply = await review(setup)
    clicked = interaction()
    await button(reply, "enter").callback(clicked)
    modal = clicked.response.send_modal.call_args.args[0]
    modal.amount._value = amount
    modal.when._value = when or now_pacific().date().isoformat()
    modal.note._value = "Actual repayment"
    submitted = interaction()
    await modal.on_submit(submitted)
    return reply, submitted


@pytest.mark.asyncio
async def test_review_modal_and_separate_cancel_never_record_receipt(setup):
    first, submitted = await confirm_review(setup)
    assert "$125.00" in text(first) and "$44.09" in text(first)
    assert "$12.34" in text(submitted) and "Confirm received record" in text(submitted)
    assert setup.store.snapshot("brian")["events"] == []
    canceled = interaction()
    await button(submitted, "cancel").callback(canceled)
    assert "Canceled" in text(canceled)
    await button(submitted, "confirm").callback(interaction())
    assert setup.store.snapshot("brian")["events"] == []
    assert setup.values[1] == setup.bank


@pytest.mark.asyncio
async def test_partial_receipt_requires_confirmation_and_repeat_click_is_safe(setup):
    _, submitted = await confirm_review(setup)
    clicked = interaction()
    await button(submitted, "confirm").callback(clicked)
    result = setup.store.snapshot("brian")
    assert len(result["events"]) == 1 and result["events"][0]["amountCents"] == 1234
    assert result["allocations"][0]["outstandingCents"] == 3175
    assert result["allocations"][0]["grossCents"] == 12500
    assert result["events"][0]["date"] == now_pacific().date().isoformat()
    assert "bank match is unchanged" in text(clicked)
    await asyncio.gather(*(button(submitted, "confirm").callback(interaction()) for _ in range(2)))
    assert len(setup.store.snapshot("brian")["events"]) == 1
    assert setup.values[1] == setup.bank


@pytest.mark.asyncio
@pytest.mark.parametrize("stage", ["entry", "modal", "confirmation"])
async def test_other_actor_cannot_open_or_submit_receipt(setup, stage):
    first, submitted = await confirm_review(setup)
    foreign = interaction("830984827904851969")
    if stage == "entry":
        await button(first, "enter").callback(foreign)
    elif stage == "confirmation":
        await button(submitted, "confirm").callback(foreign)
    else:
        modal = receipts._ReceiptModal(button(first, "enter").callback_func.__self__)
        await modal.on_submit(foreign)
    foreign.response.send_message.assert_awaited_once()
    foreign.response.defer.assert_not_awaited()
    foreign.response.send_modal.assert_not_awaited()
    assert not setup.store.snapshot("brian")["events"]


@pytest.mark.asyncio
@pytest.mark.parametrize("problem", ["bank_reopened", "bank_gross", "balance", "pending", "projection"])
async def test_confirmation_rechecks_shared_and_bank_state(setup, problem):
    _, submitted = await confirm_review(setup)
    if problem == "bank_reopened":
        setup.values[1] = replace(setup.bank, status="needs_review")
    elif problem == "bank_gross":
        setup.values[1] = replace(setup.bank, transaction=replace(setup.bank.transaction, amount=126))
    elif problem == "balance":
        setup.store.command("brian", payment(setup.row, 100))
    elif problem == "pending":
        setup.store.command("hannah", payment(setup.row, 100, "report_payment"))
    else:
        setup.store.revise_allocation("brian", setup.row["id"], setup.row["version"], {"item": "Corrected bill"}, operation="update")
    previous = setup.store.snapshot("brian")
    clicked = interaction()
    await button(submitted, "confirm").callback(clicked)
    assert setup.store.snapshot("brian") == previous
    assert "fresh" in text(clicked)


@pytest.mark.asyncio
@pytest.mark.parametrize("amount,when", [("0", None), ("44.10", None), ("1.001", None), ("abc", None),
    ("1", "2030-01-01"), ("1", "2020-01-01"), ("1", "20261023"), ("1", "invalid")])
async def test_invalid_amounts_and_dates_never_offer_confirmation(setup, amount, when):
    _, submitted = await confirm_review(setup, amount, when)
    assert all("view" not in call.kwargs for call in submitted.followup.send.call_args_list)
    assert not setup.store.snapshot("brian")["events"]


@pytest.mark.asyncio
async def test_pending_report_is_confirmed_once_without_an_extra_receipt(setup):
    sent = setup.store.command("hannah", payment(setup.row, 1500, "report_payment"))["events"][0]
    reply = await review(setup)
    assert all(getattr(child, "action", None) != "enter" for child in view(reply).children)
    selector = view(reply).children[0]
    selector._values = [f"reported:{sent['id']}"]
    selected = interaction()
    await selector.callback(selected)
    assert "$15.00" in text(selected)
    assert setup.store.snapshot("brian")["events"][0]["status"] == "pending"
    await button(selected, "confirm").callback(interaction())
    events = setup.store.snapshot("brian")["events"]
    assert len(events) == 1 and events[0]["id"] == sent["id"] and events[0]["status"] == "confirmed"
    assert setup.store.get_allocation(setup.row["id"])["outstandingCents"] == 2909


@pytest.mark.asyncio
async def test_lost_response_retry_uses_same_command_even_after_bank_changes(setup, monkeypatch):
    first, submitted = await confirm_review(setup)
    real = service.command
    bodies = []
    def lost(owner, body):
        bodies.append(dict(body))
        result = real(owner, body)
        if len(bodies) == 1:
            raise RuntimeError("Response lost after durable commit")
        return result
    monkeypatch.setattr(service, "command", lost)
    uncertain = interaction()
    await button(submitted, "confirm").callback(uncertain)
    assert [child.label for child in view(uncertain).children] == ["Retry this record"]
    canceled = interaction()
    await button(first, "cancel").callback(canceled)
    assert "No repayment was recorded" not in text(canceled) and "Retry" in text(canceled)
    # A new bank state cannot block recovery of the already committed receipt.
    setup.values[1] = replace(setup.bank, status="needs_review")
    retried = interaction()
    await button(uncertain, "confirm").callback(retried)
    assert len(bodies) == 2 and bodies[0] == bodies[1]
    assert len(setup.store.snapshot("brian")["events"]) == 1
    assert "Recorded" in text(retried)


@pytest.mark.asyncio
async def test_projection_pending_disables_new_receipt_until_explicit_refresh(setup, monkeypatch):
    _, submitted = await confirm_review(setup)
    monkeypatch.setattr(projection, "sync_pending", lambda store: False)
    clicked = interaction()
    await button(submitted, "confirm").callback(clicked)
    assert "pending" in text(clicked)
    pending = await review(setup)
    assert [child.action for child in view(pending).children] == ["refresh", "cancel"]
    events = setup.store.snapshot("brian")["events"]
    await button(pending, "refresh").callback(interaction())
    assert setup.store.snapshot("brian")["events"] == events


@pytest.mark.asyncio
async def test_inbox_includes_manual_and_auto_matches_deduplicates_and_does_no_sync(setup):
    setup.values[2] = replace(setup.bank, id=2, status="matched")
    setup.values[3] = replace(setup.bank, id=3, status="ignored")
    reply = interaction()
    await receipts.send_bank_receipt_inbox(reply, owner="brian", actor=ACTOR)
    selector = view(reply).children[0]
    assert len(selector.options) == 1 and "$44.09" in selector.options[0].label
    setup.bank_service.store.review_reconciliation_items.assert_called_once_with("brian",
        start_date=now_pacific().date().replace(day=1).isoformat(), limit=200)
    assert not setup.store.snapshot("brian")["events"]
    # Opening a choice loads its current data, not the list's old balance.
    selector._values = [selector.options[0].value]
    selected = interaction()
    await selector.callback(selected)
    assert "$125.00" in text(selected)
    assert not setup.store.snapshot("brian")["events"]


@pytest.mark.asyncio
async def test_settled_share_has_no_new_receipt_and_disappears_from_inbox(setup):
    service.command("brian", payment(setup.row, 4409))
    reply = await review(setup)
    assert [child.action for child in view(reply).children] == ["cancel"]
    empty = interaction()
    await receipts.send_bank_receipt_inbox(empty, owner="brian", actor=ACTOR)
    assert "No outstanding shares" in text(empty)


@pytest.mark.asyncio
async def test_postmatch_shortcut_is_optional_read_only_and_actor_scoped(setup, monkeypatch):
    reply = interaction()
    await receipts.offer_bank_receipt_review(reply, owner="brian", actor=ACTOR, item=setup.bank)
    assert [child.label for child in view(reply).children] == ["Review Hannah’s share"]
    foreign = interaction("other")
    await button(reply, "review").callback(foreign)
    foreign.response.send_message.assert_awaited_once()
    assert not setup.store.snapshot("brian")["events"]
    monkeypatch.setattr(receipts, "matched_receipt_link", Mock(side_effect=RuntimeError("optional unavailable")))
    await receipts.offer_bank_receipt_review(interaction(), owner="brian", actor=ACTOR, item=setup.bank)


@pytest.mark.asyncio
@pytest.mark.parametrize("persistent", [False, True])
async def test_morning_digest_receipt_button_survives_restart_and_rejects_other_actor(monkeypatch, persistent):
    send = AsyncMock()
    monkeypatch.setattr(digest, "send_bank_receipt_inbox", send)
    factory = digest.persistent_bank_reconciliation_digest_view if persistent else digest.bank_reconciliation_digest_view
    control = next(child for child in factory(ACTOR).children if child.action == "receipts")
    assert control.custom_id == f"bank_reconcile:receipts:{ACTOR}"
    clicked = interaction()
    await control.callback(clicked)
    send.assert_awaited_once_with(clicked, owner="brian", actor=ACTOR)
    clicked.response.defer.assert_awaited_once_with(ephemeral=True, thinking=False)
    await control.callback(interaction("830984827904851969"))
    assert send.await_count == 1


@pytest.mark.asyncio
async def test_inbox_receipt_button_routes_to_owner_scoped_private_review(monkeypatch):
    send = AsyncMock()
    monkeypatch.setattr(digest, "send_bank_receipt_inbox", send)
    monkeypatch.setattr(digest, "prepare_bank_reconciliation_inbox_messages", lambda *args: digest.PreparedBankReconciliationDigest(
        public_message="generic", detail_message="private inbox", item_ids=(1,), owner_key="brian"))
    reply = interaction()
    await digest._send_bank_reconciliation_inbox(reply, ACTOR)
    clicked = interaction()
    await button(reply, "receipts").callback(clicked)
    send.assert_awaited_once_with(clicked, owner="brian", actor=ACTOR)


@pytest.mark.asyncio
@pytest.mark.parametrize("kind", ["row", "schedule", "group", "group_adjust"])
async def test_successful_match_offers_separate_receipt_without_recording_one(monkeypatch, kind):
    original = item(1)
    matched = replace(original, status="confirmed", matched_action_log_id="source")
    candidate = ActionLogCandidate("schedule:source" if kind == "schedule" else "source",
        "expense!row 4#cols=1,2,3#month=2026-10", "schedule" if kind == "schedule" else "expense",
        now_pacific().date(), 20, "Shared bill", .99, "exact")
    group = ActionLogCandidateGroup("group", (candidate,), 20, .99, "exact")
    bank = SimpleNamespace(get_reconciliation_item=lambda *args: original,
        reconciliation_match_candidates=lambda *args, **kwargs: (original, [candidate], [group]),
        confirm_reconciliation_schedule_match=lambda *args, **kwargs: (matched, candidate, "matched"),
        confirm_reconciliation_action_match=lambda *args, **kwargs: (matched, candidate, "matched"),
        confirm_reconciliation_action_group_match=lambda *args, **kwargs: (matched, [candidate], "matched_adjusted" if kind == "group_adjust" else "matched"))
    offer = AsyncMock()
    monkeypatch.setattr(flow, "build_banking_service", lambda: bank)
    monkeypatch.setattr(flow, "offer_bank_receipt_review", offer)
    reply = interaction()
    await flow.send_bank_reconciliation_detail(reply, owner_key="brian", owner_name="Brian", reconciliation_id=1, actor_key=ACTOR)
    callback = next(child.callback_func for child in view(reply).children if hasattr(child, "callback_func"))
    clicked = interaction()
    action = "group:0" if kind == "group" else "group_adjust:0:source" if kind == "group_adjust" else "candidate:0"
    await callback(clicked, action)
    offer.assert_awaited_once_with(clicked, owner="brian", actor=ACTOR, item=matched)
    assert "Matched" in text(clicked)


@pytest.mark.asyncio
async def test_preflight_read_failure_does_not_enable_retry_that_skips_bank_checks(setup, monkeypatch):
    _, submitted = await confirm_review(setup)
    real = receipts._context
    monkeypatch.setattr(receipts, "_context", Mock(side_effect=RuntimeError("Read unavailable")))
    failed = interaction()
    await button(submitted, "confirm").callback(failed)
    assert "Nothing was recorded" in text(failed)
    monkeypatch.setattr(receipts, "_context", real)
    setup.values[1] = replace(setup.bank, status="needs_review")
    await button(submitted, "confirm").callback(interaction())
    assert not setup.store.snapshot("brian")["events"]


@pytest.mark.asyncio
async def test_multiple_modal_submits_cannot_replace_an_unfinished_command(setup):
    first, submitted = await confirm_review(setup)
    review_controller = button(first, "enter").callback_func.__self__
    modal = receipts._ReceiptModal(review_controller)
    modal.amount._value, modal.when._value, modal.note._value = "5", now_pacific().date().isoformat(), ""
    second = interaction()
    await modal.on_submit(second)
    assert "$12.34" in text(second) and "$5.00" not in text(second)
    await button(submitted, "confirm").callback(interaction())
    assert setup.store.snapshot("brian")["events"][0]["amountCents"] == 1234


@pytest.mark.asyncio
async def test_known_command_rejection_is_closed_and_does_not_record_receipt(setup, monkeypatch):
    _, submitted = await confirm_review(setup)
    monkeypatch.setattr(service, "command", Mock(side_effect=receipts.ReimbursementConflictError("Changed concurrently")))
    failed = interaction()
    await button(submitted, "confirm").callback(failed)
    assert "fresh" in text(failed) and "Retry" not in text(failed)
    assert not setup.store.snapshot("brian")["events"]


@pytest.mark.asyncio
async def test_shared_inbox_pages_all_eligible_choices(setup):
    for identity in range(2, 28):
        row = setup.store.register_allocation(payload(expenseDate=now_pacific().date().isoformat(),
            sourceYear=now_pacific().year, sourceSheetTitle=now_pacific().strftime("%B"), grossCents=12500,
            payerShareCents=8091, partnerShareCents=4409))
        setup.store.mark_projected(row["id"], row["version"])
        setup.values[identity] = replace(setup.bank, id=identity, matched_action_log_id=row["sourceActionId"])
    reply = interaction()
    await receipts.send_bank_receipt_inbox(reply, owner="brian", actor=ACTOR)
    assert len(view(reply).children[0].options) == 25
    last = interaction()
    await button(reply, "next").callback(last)
    assert "page 2 of 2" in text(last) and len(view(last).children[0].options) == 2
    assert [child.action for child in view(last).children if hasattr(child, "action")] == ["previous"]
    assert not setup.store.snapshot("brian")["events"]


@pytest.mark.asyncio
async def test_receipt_reviews_serialize_as_real_private_discord_components(setup, discord_followup):
    webhook, adapter, state = discord_followup
    reply = interaction()
    reply.followup = webhook
    await receipts.send_bank_receipt_inbox(reply, owner="brian", actor=ACTOR)
    selector = state.store_view.call_args.args[0].children[0]
    selector._values = [selector.options[0].value]
    selected = interaction()
    selected.followup = webhook
    await selector.callback(selected)
    entered = interaction()
    review_view = state.store_view.call_args.args[0]
    await next(child for child in review_view.children if child.action == "enter").callback(entered)
    modal = entered.response.send_modal.call_args.args[0]
    components = modal.to_dict()["components"]
    assert len(components) == 3
    assert components[0]["components"][0]["value"] == "44.09"
    modal.amount._value, modal.when._value, modal.note._value = "12.34", now_pacific().date().isoformat(), ""
    submitted = interaction()
    submitted.followup = webhook
    await modal.on_submit(submitted)
    bodies = [call.kwargs["payload"] for call in adapter.execute_webhook.await_args_list]
    assert len(bodies) == 3 and all(body["flags"] & 64 for body in bodies)
    assert [component["label"] for row in bodies[-1]["components"] for component in row["components"]] == ["Confirm received record", "Cancel"]
    assert not setup.store.snapshot("brian")["events"]


@pytest.mark.asyncio
async def test_typed_error_after_commit_still_recovers_original_command(setup, monkeypatch):
    _, submitted = await confirm_review(setup)
    real = service.command
    count = 0
    def committed_then_failed(owner, body):
        nonlocal count
        count += 1
        result = real(owner, body)
        if count == 1:
            raise receipts.ReimbursementConflictError("Projection response unavailable after commit")
        return result
    monkeypatch.setattr(service, "command", committed_then_failed)
    uncertain = interaction()
    await button(submitted, "confirm").callback(uncertain)
    assert [child.label for child in view(uncertain).children] == ["Retry this record"]
    await button(uncertain, "confirm").callback(interaction())
    assert len(setup.store.snapshot("brian")["events"]) == 1
