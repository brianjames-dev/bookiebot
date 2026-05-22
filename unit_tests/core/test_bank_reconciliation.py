from datetime import date, datetime
from types import SimpleNamespace
import pytest

from bookiebot.banking.models import BankTransaction, ReconciliationCacheBuckets, ReconciliationItem, ReconciliationPreview
import bookiebot.core.bank_reconciliation as bank_reconciliation
from bookiebot.core.bank_reconciliation import (
    _parse_specific_snooze_time,
    _resolve_snooze,
    format_bank_reconciliation_digest,
)


class FakeChannel:
    def __init__(self):
        self.messages = []

    async def send(self, content, **kwargs):
        self.messages.append((content, kwargs))


class FailingChannel:
    async def send(self, content, **kwargs):
        raise RuntimeError("discord send failed")


class FakeClient:
    def __init__(self, channel):
        self.channel = channel
        self.views = []

    def get_channel(self, _channel_id):
        return self.channel

    def add_view(self, view):
        self.views.append(view)


class FakeInteraction:
    def __init__(self, *, user_id="123", message_id="456"):
        self.user = SimpleNamespace(id=user_id)
        self.message = SimpleNamespace(id=message_id)


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

    output = format_bank_reconciliation_digest("<@123>", preview, [item])

    assert "<@123> bank reconciliation found `1` item that needs review." in output
    assert "Bank cache:" in output
    assert "- Stored bank transactions: `26`" in output
    assert "- Needs review: `1`" in output
    assert "- Matched automatically: `10`" in output
    assert "- Confirmed/logged: `8`" in output
    assert "- Ignored: `2`" in output
    assert "- Pending: `3`" in output
    assert "- Not reviewed yet: `1`" in output
    assert "- Unwatched accounts: `1`" in output
    assert "- Checked this run: `1`" in output
    assert "Unresolved bank reconciliation items:" in output
    assert "  42  05-18    $12.34  expense   Unlogged Coffee" in output


@pytest.mark.asyncio
async def test_bank_reconciliation_digest_view_is_persistent():
    view = bank_reconciliation.bank_reconciliation_digest_view("123")

    assert view.timeout is None
    assert [child.custom_id for child in view.children] == [
        "bank_reconcile:start:123",
        "bank_reconcile:later:123",
    ]


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


def test_prepare_bank_reconciliation_digest_uses_cached_items_when_sync_fails(monkeypatch):
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
        config = SimpleNamespace(configured=True)

        async def sync_owner(self, _owner_key):
            raise RuntimeError("Plaid unavailable")

        def reconciliation_preview(self, owner_key, *, limit, actor_key):
            return ReconciliationPreview(
                owner_key=owner_key,
                items=[item],
                cached_transaction_count=1,
                candidate_transaction_count=1,
            )

        def unresolved_reconciliation_items(self, _owner_key, *, limit):
            return [item]

    monkeypatch.setattr(
        bank_reconciliation,
        "get_user_config",
        lambda _actor_key: SimpleNamespace(budget_owner_key="brian"),
    )
    monkeypatch.setattr(bank_reconciliation, "build_banking_service", lambda: FakeService())
    monkeypatch.setattr(bank_reconciliation, "has_system_event", lambda *_args: False)

    output = bank_reconciliation.prepare_bank_reconciliation_digest(
        "123",
        "<@123>",
        date(2026, 5, 20),
        mark_sent=False,
        force=False,
    )

    assert output is not None
    assert "bank reconciliation found `1` item" in output
    assert "Bank sync warning: using cached bank data for this digest." in output
    assert "Unlogged Coffee" in output


def test_resolve_snooze_options_use_readable_labels():
    current = datetime(2026, 5, 18, 14, 30)

    label, remind_at = _resolve_snooze("1h", current)
    assert label == "in 1 hour"
    assert remind_at == datetime(2026, 5, 18, 15, 30)

    label, remind_at = _resolve_snooze("2h", current)
    assert label == "in 2 hours"
    assert remind_at == datetime(2026, 5, 18, 16, 30)

    label, remind_at = _resolve_snooze("tomorrow", current)
    assert label == "tomorrow at the same time"
    assert remind_at == datetime(2026, 5, 19, 14, 30)


def test_parse_specific_snooze_time_rolls_past_times_to_tomorrow():
    current = datetime(2026, 5, 18, 14, 30)

    assert _parse_specific_snooze_time("3:30 PM", current) == datetime(2026, 5, 18, 15, 30)
    assert _parse_specific_snooze_time("9 AM", current) == datetime(2026, 5, 19, 9, 0)
    assert _parse_specific_snooze_time("tomorrow 9 AM", current) == datetime(2026, 5, 19, 9, 0)
    assert _parse_specific_snooze_time("not a time", current) is None


@pytest.mark.asyncio
async def test_bank_digest_records_sent_event_only_after_discord_send(monkeypatch):
    recorded = []
    channel = FakeChannel()
    client = FakeClient(channel)
    async def no_snoozed(*_args):
        return 0

    monkeypatch.setenv("CHANNEL_ID", "123")
    monkeypatch.setattr(bank_reconciliation, "_send_due_snoozed_bank_reconciliation_digests", no_snoozed)
    monkeypatch.setattr(bank_reconciliation, "_notification_users", lambda: [("676638528590970917", "<@676638528590970917>")])
    monkeypatch.setattr(bank_reconciliation, "prepare_bank_reconciliation_digest", lambda *_args, **_kwargs: "digest")
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
    assert channel.messages[0][0] == "digest\n\u200b"
    assert recorded == [
        (
            "676638528590970917",
            "bank_reconciliation_digest_sent",
            {"digest_date": "2026-05-20", "sent_after": "discord_send"},
            "Bank reconciliation digest sent for 2026-05-20",
        )
    ]


@pytest.mark.asyncio
async def test_bank_digest_does_not_record_sent_event_when_discord_send_fails(monkeypatch):
    recorded = []
    client = FakeClient(FailingChannel())
    async def no_snoozed(*_args):
        return 0

    monkeypatch.setenv("CHANNEL_ID", "123")
    monkeypatch.setattr(bank_reconciliation, "_send_due_snoozed_bank_reconciliation_digests", no_snoozed)
    monkeypatch.setattr(bank_reconciliation, "_notification_users", lambda: [("676638528590970917", "<@676638528590970917>")])
    monkeypatch.setattr(bank_reconciliation, "prepare_bank_reconciliation_digest", lambda *_args, **_kwargs: "digest")
    monkeypatch.setattr(
        bank_reconciliation,
        "record_system_event",
        lambda *args: recorded.append(args) or True,
    )

    with pytest.raises(RuntimeError, match="discord send failed"):
        await bank_reconciliation.send_due_bank_reconciliation_digest(client, today=datetime(2026, 5, 20).date())

    assert recorded == []
