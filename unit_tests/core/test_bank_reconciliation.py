import asyncio
from dataclasses import replace
from datetime import date, datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock
import discord
from discord.webhook.async_ import async_context
import pytest

from bookiebot.banking.models import (
    BankTransaction,
    ReconciliationCacheBuckets,
    ReconciliationItem,
    ReconciliationPreview,
    ReconciliationReportMatch,
)
import bookiebot.core.bank_reconciliation as bank_reconciliation
from bookiebot.core.bank_reconciliation import (
    _is_eligible,
    format_bank_reconciliation_digest,
    format_bank_reconciliation_digest_chunks,
    format_bank_reconciliation_public_prompt,
)


class FakeChannel:
    def __init__(self):
        self.messages = []

    async def send(self, content, **kwargs):
        self.messages.append((content, kwargs))


class FailingChannel:
    async def send(self, content, **kwargs):
        raise RuntimeError("discord send failed")


class FakeUser:
    def __init__(self):
        self.messages = []

    async def send(self, content, **kwargs):
        self.messages.append((content, kwargs))


class FailingUser:
    async def send(self, content, **kwargs):
        raise RuntimeError("discord dm failed")


class FakeClient:
    def __init__(self, channel, *, user=None):
        self.channel = channel
        self.user = user
        self.views = []

    def get_channel(self, _channel_id):
        return self.channel

    def get_user(self, _user_id):
        return self.user

    def add_view(self, view):
        self.views.append(view)


class FakeInteraction:
    def __init__(self, *, user_id="123", message_id="456"):
        self.user = SimpleNamespace(id=user_id)
        self.message = SimpleNamespace(id=message_id)


class FakeResponse:
    def __init__(self):
        self.deferred = False
        self.defer_kwargs = {}

    async def defer(self, **kwargs):
        self.deferred = True
        self.defer_kwargs = kwargs


class FakeFollowup:
    def __init__(self):
        self.messages = []

    async def send(self, content=None, **kwargs):
        self.messages.append((content, kwargs))


class FakeTyping:
    def __init__(self, channel):
        self.channel = channel

    async def __aenter__(self):
        self.channel.enters += 1

    async def __aexit__(self, exc_type, exc, tb):
        self.channel.exits += 1


class FakeTypingChannel:
    def __init__(self):
        self.enters = 0
        self.exits = 0

    def typing(self):
        return FakeTyping(self)


class FakeReviewInteraction:
    def __init__(self):
        self.response = FakeResponse()
        self.followup = FakeFollowup()
        self.original_response_edits = []
        self.channel = FakeTypingChannel()

    async def edit_original_response(self, **kwargs):
        self.original_response_edits.append(kwargs)


@pytest.fixture
def discord_followup(monkeypatch):
    """Exercise Discord's real validation/serialization without making HTTP calls."""
    adapter = SimpleNamespace(execute_webhook=AsyncMock(return_value={"id": "789"}))
    state = SimpleNamespace(store_view=Mock())
    webhook = discord.Webhook(
        {"id": "123", "type": 3, "token": "test-token"},
        session=SimpleNamespace(),
        state=state,
    )
    monkeypatch.setattr(
        discord.Webhook,
        "_create_message",
        lambda _self, data, **_kwargs: SimpleNamespace(id=int(data["id"])),
    )
    token = async_context.set(adapter)
    try:
        yield webhook, adapter, state
    finally:
        async_context.reset(token)


def _reconciliation_item(item_id: int, *, name: str) -> ReconciliationItem:
    transaction = BankTransaction(
        id=item_id,
        provider_transaction_id=f"txn-{item_id}",
        owner_key="brian",
        account_name="Checking",
        account_mask="0000",
        account_type="depository",
        account_subtype="checking",
        date="2026-05-18",
        authorized_date=None,
        name=name,
        merchant_name=None,
        amount=12.34,
        pending=False,
        payment_channel="bookiebot_debug",
        updated_at="2026-05-18T00:00:00+00:00",
    )
    return ReconciliationItem(
        id=item_id,
        owner_key="brian",
        bank_transaction_id=item_id,
        provider_transaction_id=f"txn-{item_id}",
        classification="expense",
        status="needs_review",
        confidence=0.6,
        matched_action_log_id=None,
        matched_sheet_ref=None,
        first_seen_at="2026-05-18T00:00:00+00:00",
        last_seen_at="2026-05-18T00:00:00+00:00",
        resolved_at=None,
        ignored_at=None,
        notes="outflow transaction",
        transaction=transaction,
    )


def _matched_reconciliation_item(item_id: int, *, name: str) -> ReconciliationItem:
    return replace(
        _reconciliation_item(item_id, name=name),
        classification="transfer_or_payment",
        status="matched",
        confidence=0.95,
        notes="automatic rule",
    )


def test_format_bank_reconciliation_digest_lists_unresolved_items():
    transaction = BankTransaction(
        id=1,
        provider_transaction_id="txn-1",
        owner_key="brian",
        account_name="Checking",
        account_mask="0000",
        account_type="depository",
        account_subtype="checking",
        date="2026-05-18",
        authorized_date=None,
        name="Unlogged Coffee",
        merchant_name=None,
        amount=12.34,
        pending=False,
        payment_channel="bookiebot_debug",
        updated_at="2026-05-18T00:00:00+00:00",
    )
    item = ReconciliationItem(
        id=42,
        owner_key="brian",
        bank_transaction_id=1,
        provider_transaction_id="txn-1",
        classification="expense",
        status="needs_review",
        confidence=0.6,
        matched_action_log_id=None,
        matched_sheet_ref=None,
        first_seen_at="2026-05-18T00:00:00+00:00",
        last_seen_at="2026-05-18T00:00:00+00:00",
        resolved_at=None,
        ignored_at=None,
        notes="outflow transaction",
        transaction=transaction,
    )
    preview = ReconciliationPreview(
        owner_key="brian",
        items=[item],
        cached_transaction_count=26,
        candidate_transaction_count=1,
        cache_buckets=ReconciliationCacheBuckets(
            stored=26,
            needs_review=1,
            matched=10,
            confirmed=8,
            ignored=2,
            pending=3,
            not_reviewed=1,
            unwatched=1,
        ),
    )

    output = format_bank_reconciliation_digest("<@123>", preview, [item], report_matches=[])

    assert "<@123> bank reconciliation found `1` item that needs review." in output
    assert "Bank cache:" in output
    assert "- Stored bank transactions: `26`" in output
    assert "- Needs review: `1`" in output
    assert "- Matched automatically: `10`" in output
    assert "- Confirmed/logged: `8`" in output
    assert "- Ignored: `2`" in output
    assert "- Pending: `3`" in output
    assert "Pending Plaid transactions are cached" not in output
    assert "Not reviewed yet" not in output
    assert "Unwatched accounts" not in output
    assert "Other" not in output
    assert "Checked this run" not in output
    assert "Unresolved bank reconciliation items:" in output
    assert "  42  05-18    $12.34  expense   Unlogged Coffee" in output


def test_format_bank_reconciliation_digest_lists_confirmed_run_matches():
    transaction = BankTransaction(
        id=1,
        provider_transaction_id="txn-1",
        owner_key="brian",
        account_name="Checking",
        account_mask="0000",
        account_type="depository",
        account_subtype="checking",
        date="2026-05-18",
        authorized_date=None,
        name="CREDIT CARD 3333 PAYMENT",
        merchant_name=None,
        amount=25.0,
        pending=False,
        payment_channel="bookiebot_debug",
        updated_at="2026-05-18T00:00:00+00:00",
    )
    item = ReconciliationItem(
        id=43,
        owner_key="brian",
        bank_transaction_id=1,
        provider_transaction_id="txn-1",
        classification="transfer_or_payment",
        status="matched",
        confidence=0.95,
        matched_action_log_id=None,
        matched_sheet_ref=None,
        first_seen_at="2026-05-18T00:00:00+00:00",
        last_seen_at="2026-05-18T00:00:00+00:00",
        resolved_at=None,
        ignored_at=None,
        notes="transfer/payment pattern",
        transaction=transaction,
    )
    preview = ReconciliationPreview(
        owner_key="brian",
        items=[item],
        candidate_transaction_count=1,
        cache_buckets=ReconciliationCacheBuckets(stored=2, matched=1, pending=1),
    )

    output = format_bank_reconciliation_digest(
        "<@123>",
        preview,
        [],
        report_matches=[
            ReconciliationReportMatch(
                reconciliation_id=43,
                bank_date="2026-05-18",
                bank_name="CREDIT CARD 3333 PAYMENT",
                bank_amount=25.0,
                matched_date=None,
                matched_name=None,
                matched_amount=None,
                source_type="automatic rule",
                reason="transfer/payment pattern",
                confidence=0.95,
            )
        ],
    )

    assert "confirmed `1` automatic match" in output
    assert "Confirmed matches this run:" in output
    assert "```text\nBank:" in output
    assert "Bank:   05-18    $25.00  CREDIT CARD 3333 PAYMENT" in output
    assert "Sheet:  no spreadsheet row (automatic rule)" in output
    assert "Reason: transfer/payment pattern" in output
    assert "Conf:   95%" in output


def test_format_bank_reconciliation_digest_compares_bank_and_sheet_match():
    transaction = BankTransaction(
        id=1,
        provider_transaction_id="txn-1",
        owner_key="brian",
        account_name="Checking",
        account_mask="0000",
        account_type="depository",
        account_subtype="checking",
        date="2026-05-18",
        authorized_date=None,
        name="Amazon",
        merchant_name=None,
        amount=76.90,
        pending=False,
        payment_channel="bookiebot_debug",
        updated_at="2026-05-18T00:00:00+00:00",
    )
    item = ReconciliationItem(
        id=44,
        owner_key="brian",
        bank_transaction_id=1,
        provider_transaction_id="txn-1",
        classification="expense",
        status="matched",
        confidence=0.92,
        matched_action_log_id="expense123",
        matched_sheet_ref="expense!row 42",
        first_seen_at="2026-05-18T00:00:00+00:00",
        last_seen_at="2026-05-18T00:00:00+00:00",
        resolved_at=None,
        ignored_at=None,
        notes="matched expense action within 1d",
        transaction=transaction,
    )
    preview = ReconciliationPreview(owner_key="brian", items=[item], candidate_transaction_count=1)

    output = format_bank_reconciliation_digest(
        "<@123>",
        preview,
        [],
        report_matches=[
            ReconciliationReportMatch(
                reconciliation_id=44,
                bank_date="2026-05-18",
                bank_name="Amazon",
                bank_amount=76.90,
                matched_date="2026-05-17",
                matched_name="Baby registry stuff at Amazon",
                matched_person="Brian (BofA)",
                matched_amount=76.90,
                source_type="spreadsheet row",
                reason="matched expense action within 1d",
                confidence=0.92,
            )
        ],
    )

    assert "```text\nBank:" in output
    assert "Bank:   05-18    $76.90  Amazon" in output
    assert "Sheet:  05-17    $76.90  Baby registry stuff at Amazon" in output
    assert "Person: Brian (BofA)" in output
    assert "Reason: matched expense action within 1d" in output
    assert "Conf:   92%" in output


def test_format_bank_reconciliation_digest_chunks_long_match_report():
    item = _matched_reconciliation_item(44, name="Amazon")
    unresolved = _reconciliation_item(45, name="Unlogged Coffee")
    preview = ReconciliationPreview(
        owner_key="brian",
        items=[unresolved, *([item] * 20)],
        candidate_transaction_count=21,
    )
    matches = [
        ReconciliationReportMatch(
            reconciliation_id=index,
            bank_date="2026-07-13",
            bank_name=f"Bank Merchant {index}",
            bank_amount=10.0 + index,
            matched_date="2026-07-12",
            matched_name=f"Sheet Item {index} at " + "Long merchant location " * 8,
            matched_person="A long person and payment-method label " * 8,
            matched_amount=10.0 + index,
            source_type="spreadsheet row",
            reason="matched expense action within 1d",
            confidence=0.86,
        )
        for index in range(1, 21)
    ]

    chunks = format_bank_reconciliation_digest_chunks(
        "<@123>",
        preview,
        [unresolved],
        report_matches=matches,
        max_chars=900,
    )

    assert len(chunks) > 1
    assert all(len(chunk) <= 900 for chunk in chunks)
    assert "Unresolved bank reconciliation items:" in chunks[0]
    assert "Unlogged Coffee" in chunks[0]
    joined = "\n".join(chunks)
    assert joined.count("```text") == 21
    assert "Bank Merchant 1" in joined
    assert "Bank Merchant 20" in joined


def test_format_bank_reconciliation_public_prompt_hides_transaction_details():
    output = format_bank_reconciliation_public_prompt("<@123>", 2)

    assert "<@123> bank reconciliation has `2` items that need review." in output
    assert "`Reconcile Now`" in output
    assert "`View Inbox`" in output
    assert "Unresolved bank reconciliation items" not in output


def test_bank_reconciliation_digest_eligibility_uses_morning_window(monkeypatch):
    monkeypatch.setenv("BOOKIEBOT_BANK_RECONCILIATION_SEND_HOUR", "7")
    monkeypatch.setenv("BOOKIEBOT_BANK_RECONCILIATION_SEND_WINDOW_MINUTES", "60")

    assert _is_eligible(datetime(2026, 5, 20, 6, 59)) is False
    assert _is_eligible(datetime(2026, 5, 20, 7, 0)) is True
    assert _is_eligible(datetime(2026, 5, 20, 7, 59)) is True
    assert _is_eligible(datetime(2026, 5, 20, 8, 0)) is False
    assert _is_eligible(datetime(2026, 5, 20, 14, 30)) is False


@pytest.mark.asyncio
async def test_bank_reconciliation_digest_view_is_persistent():
    view = bank_reconciliation.bank_reconciliation_digest_view("123")

    assert view.timeout is None
    assert [child.custom_id for child in view.children] == [
        "bank_reconcile:start:123",
        "bank_reconcile:inbox:123",
        "bank_reconcile:resync:123",
        "bank_reconcile:receipts:123",
    ]


@pytest.mark.asyncio
async def test_bank_reconciliation_digest_view_inbox_button_runs_private_inbox(monkeypatch):
    send_inbox = AsyncMock()
    monkeypatch.setattr(bank_reconciliation, "_send_bank_reconciliation_inbox", send_inbox)
    view = bank_reconciliation.bank_reconciliation_digest_view("123")
    inbox_button = next(child for child in view.children if getattr(child, "label", None) == "View Inbox")
    interaction = FakeReviewInteraction()
    interaction.user = SimpleNamespace(id="123")

    await inbox_button.callback(interaction)

    assert interaction.response.deferred is True
    assert interaction.response.defer_kwargs == {"ephemeral": True, "thinking": False}
    assert interaction.channel.enters == 1
    assert interaction.channel.exits == 1
    send_inbox.assert_awaited_once_with(interaction, "123")


@pytest.mark.asyncio
async def test_bank_reconciliation_digest_view_reconcile_button_shows_typing(monkeypatch):
    start_reconciliation = AsyncMock()
    monkeypatch.setattr(
        bank_reconciliation,
        "_start_bank_reconciliation_from_prompt",
        start_reconciliation,
    )
    view = bank_reconciliation.bank_reconciliation_digest_view("123")
    reconcile_button = next(child for child in view.children if getattr(child, "label", None) == "Reconcile Now")
    interaction = FakeReviewInteraction()
    interaction.user = SimpleNamespace(id="123")

    await reconcile_button.callback(interaction)

    assert interaction.response.defer_kwargs == {"ephemeral": True, "thinking": False}
    assert interaction.channel.enters == 1
    assert interaction.channel.exits == 1
    start_reconciliation.assert_awaited_once_with(interaction, "123", clear_prompt=True)


@pytest.mark.asyncio
async def test_register_persistent_bank_reconciliation_view_once(monkeypatch):
    client = FakeClient(FakeChannel())
    bank_reconciliation._PERSISTENT_DIGEST_VIEW_REGISTERED = False
    monkeypatch.setattr(bank_reconciliation, "_notification_users", lambda: [("123", "<@123>")])

    bank_reconciliation.register_persistent_bank_reconciliation_views(client)
    bank_reconciliation.register_persistent_bank_reconciliation_views(client)

    assert len(client.views) == 1
    assert client.views[0].timeout is None


@pytest.mark.asyncio
async def test_claim_bank_reconciliation_prompt_allows_one_start(monkeypatch):
    seen = set()

    def fake_has_event(user_key, event_type, metadata):
        return (user_key, event_type, tuple(sorted(metadata.items()))) in seen

    def fake_record_event(user_key, event_type, metadata, description):
        seen.add((user_key, event_type, tuple(sorted(metadata.items()))))
        return True

    monkeypatch.setattr(bank_reconciliation, "has_system_event", fake_has_event)
    monkeypatch.setattr(bank_reconciliation, "record_system_event", fake_record_event)

    interaction = FakeInteraction(user_id="123", message_id="456")

    assert await bank_reconciliation._claim_bank_reconciliation_prompt(interaction, "123") is True
    assert await bank_reconciliation._claim_bank_reconciliation_prompt(interaction, "123") is False


def test_prepare_bank_reconciliation_digest_reports_sync_failure_instead_of_stale_review(monkeypatch):
    transaction = BankTransaction(
        id=1,
        provider_transaction_id="txn-1",
        owner_key="brian",
        account_name="Checking",
        account_mask="0000",
        account_type="depository",
        account_subtype="checking",
        date="2026-05-18",
        authorized_date=None,
        name="Unlogged Coffee",
        merchant_name=None,
        amount=12.34,
        pending=False,
        payment_channel="bookiebot_debug",
        updated_at="2026-05-18T00:00:00+00:00",
    )
    item = ReconciliationItem(
        id=42,
        owner_key="brian",
        bank_transaction_id=1,
        provider_transaction_id="txn-1",
        classification="expense",
        status="needs_review",
        confidence=0.6,
        matched_action_log_id=None,
        matched_sheet_ref=None,
        first_seen_at="2026-05-18T00:00:00+00:00",
        last_seen_at="2026-05-18T00:00:00+00:00",
        resolved_at=None,
        ignored_at=None,
        notes="outflow transaction",
        transaction=transaction,
    )

    class FakeService:
        config = SimpleNamespace(configured=True, public_base_url=None)

        def connection_issues(self, _owner_key):
            return []

        async def sync_owner(self, _owner_key):
            raise RuntimeError("Plaid unavailable")

        def reconciliation_preview(self, owner_key, *, limit, actor_key, start_date):
            return ReconciliationPreview(
                owner_key=owner_key,
                items=[item],
                cached_transaction_count=1,
                candidate_transaction_count=1,
            )

        def unresolved_reconciliation_items(self, _owner_key, *, limit, start_date):
            return [item]

        def reconciliation_report_matches(self, _owner_key, _items, *, actor_key, limit):
            return []

    monkeypatch.setattr(
        bank_reconciliation,
        "get_user_config",
        lambda _actor_key: SimpleNamespace(budget_owner_key="brian"),
    )
    monkeypatch.setattr(bank_reconciliation, "build_banking_service", lambda: FakeService())
    monkeypatch.setattr(bank_reconciliation, "_digest_events", lambda *_args: set())

    output = bank_reconciliation.prepare_bank_reconciliation_digest(
        "123",
        "<@123>",
        date(2026, 5, 20),
        mark_sent=False,
        force=False,
    )

    assert output is not None
    assert 'Bank sync failed' in output
    assert 'Pending statuses may be out of date' in output
    assert 'Unlogged Coffee' not in output


@pytest.mark.asyncio
async def test_bank_reconciliation_inbox_ignore_all_ignores_displayed_batch(monkeypatch):
    items = [
        _reconciliation_item(42, name="Unlogged Coffee"),
        _reconciliation_item(43, name="Unlogged Lunch"),
    ]
    ignored_ids = []

    class FakeService:
        config = SimpleNamespace(configured=True)

        async def sync_owner(self, _owner_key):
            raise AssertionError("View Inbox must not start a fresh bank sync")

        def reconciliation_preview(self, owner_key, *, limit, actor_key, start_date):
            raise AssertionError("View Inbox must not rescore persisted transactions")

        def unresolved_reconciliation_items(self, owner_key, *, limit, start_date):
            return [item for item in items if item.id not in ignored_ids]

        def reconciliation_cache_buckets(self, _owner_key, *, start_date):
            assert start_date == "2026-07-01"
            return ReconciliationCacheBuckets(
                stored=4,
                needs_review=2,
                matched=1,
                confirmed=1,
            )

        def matched_reconciliation_items(self, _owner_key, *, limit, start_date):
            return []

        def reconciliation_report_matches(self, _owner_key, _items, *, actor_key, limit):
            return []

        def ignore_reconciliation_item(self, owner_key, reconciliation_id, *, expected_item):
            item = next((item for item in items if item.id == reconciliation_id), None)
            if item is None or reconciliation_id in ignored_ids:
                return None
            ignored_ids.append(reconciliation_id)
            return item

    monkeypatch.setattr(
        bank_reconciliation,
        "get_user_config",
        lambda _actor_key: SimpleNamespace(budget_owner_key="brian", name="Brian"),
    )
    monkeypatch.setattr(bank_reconciliation, "now_pacific", lambda: datetime(2026, 7, 25))
    monkeypatch.setattr(bank_reconciliation, "build_banking_service", lambda: FakeService())
    monkeypatch.setattr(bank_reconciliation, "_digest_events", lambda *_args: set())
    interaction = FakeReviewInteraction()

    await bank_reconciliation._send_bank_reconciliation_inbox(interaction, "123")

    assert interaction.original_response_edits == []
    content, inbox_kwargs = interaction.followup.messages[0]
    assert "- Stored bank transactions: `4`" in content
    assert "- Needs review: `2`" in content
    assert "Unresolved bank reconciliation items:" in content
    assert "Unlogged Coffee" in content
    assert content.index("Unresolved bank reconciliation items:") < content.index("Confirmed matches this run:")
    assert inbox_kwargs["ephemeral"] is True
    view = inbox_kwargs["view"]
    ignore_all = next(child for child in view.children if getattr(child, "label", None) == "Ignore All")
    action_interaction = FakeReviewInteraction()
    action_interaction.user = SimpleNamespace(id="123")
    await ignore_all.callback(action_interaction)

    assert ignored_ids == [42, 43]
    assert action_interaction.response.defer_kwargs == {"ephemeral": True, "thinking": False}
    assert action_interaction.original_response_edits == []
    assert action_interaction.followup.messages == [
        (
            "Ignored `2` bank reconciliation item(s) from this inbox.",
            {"ephemeral": True},
        )
    ]
    assert action_interaction.channel.enters == 1
    assert action_interaction.channel.exits == 1


@pytest.mark.asyncio
async def test_bank_reconciliation_inbox_shows_recent_auto_matches_without_actions(monkeypatch):
    item = _matched_reconciliation_item(51, name="CREDIT CARD 3333 PAYMENT")

    class FakeService:
        config = SimpleNamespace(configured=True)

        async def sync_owner(self, _owner_key):
            raise AssertionError("View Inbox must not start a fresh bank sync")

        def reconciliation_preview(self, owner_key, *, limit, actor_key, start_date):
            raise AssertionError("View Inbox must not rescore persisted transactions")

        def unresolved_reconciliation_items(self, _owner_key, *, limit, start_date):
            return []

        def reconciliation_cache_buckets(self, _owner_key, *, start_date):
            assert start_date == "2026-07-01"
            return ReconciliationCacheBuckets(
                stored=3,
                needs_review=0,
                matched=1,
                confirmed=2,
            )

        def matched_reconciliation_items(self, _owner_key, *, limit, start_date):
            return [item]

        def reconciliation_report_matches(self, _owner_key, items, *, actor_key, limit):
            assert items == [item]
            assert actor_key is None
            return [
                ReconciliationReportMatch(
                    reconciliation_id=43,
                    bank_date="2026-05-18",
                    bank_name="CREDIT CARD 3333 PAYMENT",
                    bank_amount=12.34,
                    matched_date=None,
                    matched_name=None,
                    matched_amount=None,
                    source_type="automatic rule",
                    reason="automatic rule",
                    confidence=0.95,
                )
            ]

    monkeypatch.setattr(
        bank_reconciliation,
        "get_user_config",
        lambda _actor_key: SimpleNamespace(budget_owner_key="brian", name="Brian"),
    )
    monkeypatch.setattr(bank_reconciliation, "now_pacific", lambda: datetime(2026, 7, 25))
    monkeypatch.setattr(bank_reconciliation, "build_banking_service", lambda: FakeService())
    monkeypatch.setattr(bank_reconciliation, "_digest_events", lambda *_args: set())
    interaction = FakeReviewInteraction()

    await bank_reconciliation._send_bank_reconciliation_inbox(interaction, "123")

    assert interaction.original_response_edits == []
    content, kwargs = interaction.followup.messages[-1]
    assert "found no unresolved items and confirmed `1` automatic match" in content
    assert "- Stored bank transactions: `3`" in content
    assert "- Matched automatically: `1`" in content
    assert kwargs["ephemeral"] is True
    assert "Confirmed matches this run:" in content
    assert "CREDIT CARD 3333 PAYMENT" in content
    children = getattr(kwargs["view"], "children", [])
    assert len(children) == 2
    assert children[0].label == "Review shared repayments"
    assert getattr(children[1], "placeholder", "") == "Unmatch a confirmed transaction"


@pytest.mark.asyncio
async def test_bank_reconciliation_inbox_failure_returns_private_followup(monkeypatch):
    def fail_to_prepare(*_args, **_kwargs):
        raise RuntimeError("database unavailable")

    monkeypatch.setattr(
        bank_reconciliation,
        "prepare_bank_reconciliation_inbox_messages",
        fail_to_prepare,
    )
    interaction = FakeReviewInteraction()

    await bank_reconciliation._send_bank_reconciliation_inbox(interaction, "123")

    assert interaction.original_response_edits == []
    assert interaction.followup.messages == [
        (
            "I couldn't load the reconciliation inbox right now. Nothing was changed; please try again.",
            {"ephemeral": True},
        )
    ]


@pytest.mark.asyncio
@pytest.mark.parametrize("lookup", ["success", "failure", "timeout", "service-failure"])
async def test_inbox_optional_sheet_details_preserve_report_and_review_snapshot(monkeypatch, lookup):
    item = replace(_matched_reconciliation_item(51, name="Chipotle"),
        matched_action_log_id="purchase", matched_sheet_ref="expense!row 12#cols=14,15,16,17,18#month=2026-05")
    preview = ReconciliationPreview(owner_key="brian", items=[item])
    persisted = ReconciliationReportMatch(
        reconciliation_id=51, bank_date="2026-05-18", bank_name="Chipotle", bank_amount=12.34,
        matched_date=None, matched_name=None, matched_amount=None, source_type="spreadsheet row",
        reason="matched expense action", confidence=.98, matched_sheet_ref=item.matched_sheet_ref,
    )
    messages = tuple(format_bank_reconciliation_digest_chunks("<@123>", preview, [], report_matches=[persisted]))
    digest = bank_reconciliation.PreparedBankReconciliationDigest(
        public_message="public", detail_message=messages[0], detail_messages=messages,
        report_matches=(persisted,), reviewed_items=(item,), owner_key="brian", owner_name="Brian", preview=preview,
    )
    monkeypatch.setattr(bank_reconciliation, "prepare_bank_reconciliation_inbox_messages", lambda *_args: digest)
    hydrated = replace(persisted, matched_date="2026-05-17", matched_name="Dinner at Chipotle", matched_amount=12.34)
    reader = AsyncMock(return_value=[hydrated])
    if lookup == "failure":
        reader.side_effect = RuntimeError("Sheets unavailable")
    elif lookup == "timeout":
        async def slow_read(*args, **kwargs):
            await asyncio.sleep(.1)
            return [hydrated]
        reader.side_effect = slow_read
    service = SimpleNamespace(reconciliation_report_matches=lambda *args, **kwargs: None)
    def make_service():
        if lookup == "service-failure":
            raise RuntimeError("Service unavailable")
        return service
    monkeypatch.setattr(bank_reconciliation, "build_banking_service", make_service)
    monkeypatch.setattr(bank_reconciliation, "_INBOX_MATCH_DETAILS_TIMEOUT_SECONDS", .01)
    original_to_thread = asyncio.to_thread
    async def run_worker(func, *args, **kwargs):
        if func == service.reconciliation_report_matches:
            return await reader(*args, **kwargs)
        return await original_to_thread(func, *args, **kwargs)
    monkeypatch.setattr(bank_reconciliation.asyncio, "to_thread", run_worker)
    interaction = FakeReviewInteraction()

    await bank_reconciliation._send_bank_reconciliation_inbox(interaction, "123")

    text = "\n".join(content for content, _kwargs in interaction.followup.messages)
    if lookup == "success":
        assert "Sheet:  05-17    $12.34  Dinner at Chipotle" in text
    else:
        assert "Sheet:  expense!N12:R12 (2026-05); details unavailable" in text
    assert "no spreadsheet row" not in text
    assert all(kwargs["ephemeral"] for _content, kwargs in interaction.followup.messages)
    assert len(interaction.followup.messages[-1][1]["view"].children) == 2
    if lookup == "service-failure":
        reader.assert_not_awaited()
    else:
        reader.assert_awaited_once_with("brian", [item], actor_key="123", limit=100)
    assert digest.reviewed_items == (item,)


@pytest.mark.asyncio
async def test_bank_reconciliation_inbox_timeout_returns_private_followup(monkeypatch):
    async def stall_inbox_load(*_args, **_kwargs):
        await asyncio.sleep(1)

    monkeypatch.setattr(bank_reconciliation.asyncio, "to_thread", stall_inbox_load)
    monkeypatch.setattr(bank_reconciliation, "_inbox_load_timeout_seconds", lambda: 0.01)
    interaction = FakeReviewInteraction()

    await bank_reconciliation._send_bank_reconciliation_inbox(interaction, "123")

    assert interaction.original_response_edits == []
    assert interaction.followup.messages == [
        (
            "I couldn't load the reconciliation inbox in time. Nothing was changed; please try again.",
            {"ephemeral": True},
        )
    ]


@pytest.mark.asyncio
async def test_bank_reconciliation_empty_inbox_returns_private_followup(monkeypatch):
    monkeypatch.setattr(
        bank_reconciliation,
        "prepare_bank_reconciliation_inbox_messages",
        lambda *_args, **_kwargs: None,
    )
    interaction = FakeReviewInteraction()

    await bank_reconciliation._send_bank_reconciliation_inbox(interaction, "123")

    assert interaction.original_response_edits == []
    assert interaction.followup.messages == [
        (
            "Bank reconciliation is all caught up. No unresolved items remain.",
            {"ephemeral": True},
        )
    ]


@pytest.mark.asyncio
async def test_bank_reconciliation_inbox_sends_all_chunks_as_private_followups(monkeypatch):
    monkeypatch.setattr(
        bank_reconciliation,
        "prepare_bank_reconciliation_inbox_messages",
        lambda *_args, **_kwargs: bank_reconciliation.PreparedBankReconciliationDigest(
            public_message="public",
            detail_message="first chunk",
            detail_messages=("first chunk", "second chunk"),
            item_ids=(42,),
        ),
    )
    interaction = FakeReviewInteraction()

    await bank_reconciliation._send_bank_reconciliation_inbox(interaction, "123")

    assert interaction.original_response_edits == []
    assert interaction.followup.messages[0][0] == "first chunk"
    assert [
        getattr(child, "label", None)
        for child in interaction.followup.messages[0][1]["view"].children
    ] == ["Review shared repayments", "Reconcile Now", "Ignore All"]
    assert interaction.followup.messages[0][1]["ephemeral"] is True
    assert interaction.followup.messages[1] == ("second chunk", {"ephemeral": True})


@pytest.mark.asyncio
@pytest.mark.parametrize("persistent", [False, True], ids=["new-digest", "after-restart"])
@pytest.mark.parametrize("has_unresolved", [False, True], ids=["auto-matches-only", "needs-review"])
@pytest.mark.parametrize("match_count", [2, 12], ids=["one-page", "multiple-pages"])
async def test_digest_view_inbox_delivers_report_through_discord_webhook(
    monkeypatch, discord_followup, persistent, has_unresolved, match_count,
):
    items = [
        _matched_reconciliation_item(index, name=f"CREDIT CARD {index:04} PAYMENT")
        for index in range(1, match_count + 1)
    ]
    matches = [
        ReconciliationReportMatch(
            reconciliation_id=item.id,
            bank_date=item.transaction.date,
            bank_name=item.transaction.name,
            bank_amount=item.transaction.amount,
            matched_date=None,
            matched_name=None,
            matched_amount=None,
            source_type="automatic rule",
            reason="automatic rule",
            confidence=item.confidence,
        )
        for item in items
    ]
    unresolved = [_reconciliation_item(42, name="Coffee")] if has_unresolved else []
    messages = tuple(format_bank_reconciliation_digest_chunks(
        "<@123>",
        ReconciliationPreview(
            owner_key="brian", items=[*unresolved, *items],
            cached_transaction_count=len(items) + len(unresolved),
            candidate_transaction_count=len(items) + len(unresolved),
            cache_buckets=ReconciliationCacheBuckets(
                stored=len(items) + len(unresolved), matched=len(items), needs_review=len(unresolved),
            ),
        ),
        unresolved,
        report_matches=matches,
    ))
    assert (len(messages) > 1) == (match_count == 12)
    digest = bank_reconciliation.PreparedBankReconciliationDigest(
        public_message="public", detail_message=messages[0], detail_messages=messages,
        report_matches=tuple(matches), item_ids=tuple(item.id for item in unresolved),
        reviewed_items=tuple([*unresolved, *items]), owner_key="brian", owner_name="Brian",
    )
    monkeypatch.setattr(bank_reconciliation, "prepare_bank_reconciliation_inbox_messages", lambda *_args: digest)
    view_factory = (
        bank_reconciliation.persistent_bank_reconciliation_digest_view
        if persistent else bank_reconciliation.bank_reconciliation_digest_view
    )
    button = next(child for child in view_factory("123").children if child.action == "inbox")
    interaction = FakeReviewInteraction()
    interaction.user = SimpleNamespace(id="123")
    interaction.followup, adapter, state = discord_followup

    await button.callback(interaction)

    payloads = [call.kwargs["payload"] for call in adapter.execute_webhook.await_args_list]
    assert [payload["content"] for payload in payloads] == list(messages)
    assert all(payload["flags"] & 64 for payload in payloads)
    controls_index = 0 if has_unresolved else len(messages) - 1
    assert [bool(payload.get("components")) for payload in payloads] == [
        index == controls_index for index in range(len(messages))
    ]
    state.store_view.assert_called_once()
    controls = state.store_view.call_args.args[0]
    assert [child.label for child in controls.children if hasattr(child, "label")] == (
        ["Review shared repayments"] + (["Reconcile Now", "Ignore All"] if has_unresolved else [])
    )
    assert controls.children[-1].placeholder == "Unmatch a confirmed transaction"
    assert len(controls.children[-1].options) == match_count
    assert interaction.response.defer_kwargs == {"ephemeral": True, "thinking": False}
    assert interaction.channel.enters == interaction.channel.exits == 1


@pytest.mark.asyncio
async def test_bank_digest_records_sent_event_only_after_discord_send(monkeypatch):
    recorded = []
    channel = FakeChannel()
    user = FakeUser()
    client = FakeClient(channel, user=user)

    monkeypatch.setenv("CHANNEL_ID", "123")
    monkeypatch.setattr(bank_reconciliation, "_notification_users", lambda: [("676638528590970917", "<@676638528590970917>")])
    monkeypatch.setattr(
        bank_reconciliation,
        "prepare_bank_reconciliation_digest_messages",
        lambda *_args, **_kwargs: bank_reconciliation.PreparedBankReconciliationDigest(
            public_message="public digest",
            detail_message="private digest",
        ),
    )
    monkeypatch.setattr(
        bank_reconciliation,
        "record_system_event",
        lambda user_key, event_type, metadata, description: recorded.append(
            (user_key, event_type, metadata, description)
        )
        or True,
    )

    sent = await bank_reconciliation.send_due_bank_reconciliation_digest(client, today=datetime(2026, 5, 20).date())

    assert sent == 1
    assert channel.messages == []
    assert user.messages[0][0] == "public digest\n\u200b"
    assert recorded == [
        (
            "676638528590970917",
            "bank_reconciliation_digest_sent",
            {"digest_date": "2026-05-20", "sent_after": "discord_dm_send"},
            "Bank reconciliation digest sent for 2026-05-20",
        )
    ]


@pytest.mark.asyncio
async def test_bank_digest_does_not_send_after_morning_window_when_new_items_exist(monkeypatch):
    channel = FakeChannel()
    client = FakeClient(channel)

    monkeypatch.setenv("CHANNEL_ID", "123")
    monkeypatch.setenv("BOOKIEBOT_BANK_RECONCILIATION_SEND_HOUR", "7")
    monkeypatch.setenv("BOOKIEBOT_BANK_RECONCILIATION_SEND_WINDOW_MINUTES", "60")
    monkeypatch.setattr(bank_reconciliation, "now_pacific", lambda: datetime(2026, 5, 20, 14, 30))
    monkeypatch.setattr(bank_reconciliation, "_notification_users", lambda: [("676638528590970917", "<@676638528590970917>")])
    monkeypatch.setattr(
        bank_reconciliation,
        "prepare_bank_reconciliation_digest_messages",
        lambda *_args, **_kwargs: bank_reconciliation.PreparedBankReconciliationDigest(
            public_message="public digest",
            detail_message="private digest",
        ),
    )

    sent = await bank_reconciliation.send_due_bank_reconciliation_digest(client)

    assert sent == 0
    assert channel.messages == []


@pytest.mark.asyncio
async def test_bank_digest_does_not_record_sent_event_when_discord_send_fails(monkeypatch):
    recorded = []
    channel = FakeChannel()
    client = FakeClient(channel, user=FailingUser())

    monkeypatch.setenv("CHANNEL_ID", "123")
    monkeypatch.setattr(bank_reconciliation, "_notification_users", lambda: [("676638528590970917", "<@676638528590970917>")])
    monkeypatch.setattr(
        bank_reconciliation,
        "prepare_bank_reconciliation_digest_messages",
        lambda *_args, **_kwargs: bank_reconciliation.PreparedBankReconciliationDigest(
            public_message="public digest",
            detail_message="private digest",
        ),
    )
    monkeypatch.setattr(
        bank_reconciliation,
        "record_system_event",
        lambda *args: recorded.append(args) or True,
    )

    sent = await bank_reconciliation.send_due_bank_reconciliation_digest(client, today=datetime(2026, 5, 20).date())

    assert sent == 0
    assert recorded == []
    assert channel.messages == [
        (
            "<@676638528590970917> I could not send your private bank reconciliation digest. Please check your DM settings.",
            {},
        )
    ]
