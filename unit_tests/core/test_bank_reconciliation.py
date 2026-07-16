from dataclasses import replace
from datetime import date, datetime
from types import SimpleNamespace
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

    async def defer(self, **_kwargs):
        self.deferred = True


class FakeFollowup:
    def __init__(self):
        self.messages = []

    async def send(self, content=None, **kwargs):
        self.messages.append((content, kwargs))


class FakeReviewInteraction:
    def __init__(self):
        self.response = FakeResponse()
        self.followup = FakeFollowup()


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
    assert "Reason: matched expense action within 1d" in output
    assert "Conf:   92%" in output


def test_format_bank_reconciliation_digest_chunks_long_match_report():
    item = _matched_reconciliation_item(44, name="Amazon")
    preview = ReconciliationPreview(owner_key="brian", items=[item] * 20, candidate_transaction_count=20)
    matches = [
        ReconciliationReportMatch(
            reconciliation_id=index,
            bank_date="2026-07-13",
            bank_name=f"Bank Merchant {index}",
            bank_amount=10.0 + index,
            matched_date="2026-07-12",
            matched_name=f"Sheet Item {index}",
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
        [],
        report_matches=matches,
        max_chars=900,
    )

    assert len(chunks) > 1
    assert all(len(chunk) <= 900 for chunk in chunks)
    joined = "\n".join(chunks)
    assert joined.count("```text") == 20
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
            return None

        def reconciliation_preview(self, owner_key, *, limit, actor_key, start_date):
            return ReconciliationPreview(
                owner_key=owner_key,
                items=items,
                cached_transaction_count=2,
                candidate_transaction_count=2,
            )

        def unresolved_reconciliation_items(self, owner_key, *, limit, start_date):
            return [item for item in items if item.id not in ignored_ids]

        def matched_reconciliation_items(self, _owner_key, *, limit, start_date):
            return []

        def reconciliation_report_matches(self, _owner_key, _items, *, actor_key, limit):
            return []

        def ignore_reconciliation_item(self, owner_key, reconciliation_id):
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
    monkeypatch.setattr(bank_reconciliation, "build_banking_service", lambda: FakeService())
    monkeypatch.setattr(bank_reconciliation, "has_system_event", lambda *_args: False)
    interaction = FakeReviewInteraction()

    await bank_reconciliation._send_bank_reconciliation_inbox(interaction, "123")

    view = interaction.followup.messages[0][1]["view"]
    ignore_all = next(child for child in view.children if getattr(child, "label", None) == "Ignore All")
    action_interaction = FakeReviewInteraction()
    action_interaction.user = SimpleNamespace(id="123")
    await ignore_all.callback(action_interaction)

    assert ignored_ids == [42, 43]
    assert action_interaction.followup.messages[-1][0] == "Ignored `2` bank reconciliation item(s) from this inbox."


@pytest.mark.asyncio
async def test_bank_reconciliation_inbox_shows_recent_auto_matches_without_actions(monkeypatch):
    item = _matched_reconciliation_item(51, name="CREDIT CARD 3333 PAYMENT")

    class FakeService:
        config = SimpleNamespace(configured=True)

        async def sync_owner(self, _owner_key):
            return None

        def reconciliation_preview(self, owner_key, *, limit, actor_key, start_date):
            return ReconciliationPreview(
                owner_key=owner_key,
                items=[],
                cached_transaction_count=1,
                candidate_transaction_count=0,
                cache_buckets=ReconciliationCacheBuckets(stored=1, matched=1),
            )

        def unresolved_reconciliation_items(self, _owner_key, *, limit, start_date):
            return []

        def matched_reconciliation_items(self, _owner_key, *, limit, start_date):
            return [item]

        def reconciliation_report_matches(self, _owner_key, items, *, actor_key, limit):
            assert items == [item]
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
    monkeypatch.setattr(bank_reconciliation, "build_banking_service", lambda: FakeService())
    monkeypatch.setattr(bank_reconciliation, "has_system_event", lambda *_args: False)
    interaction = FakeReviewInteraction()

    await bank_reconciliation._send_bank_reconciliation_inbox(interaction, "123")

    content, kwargs = interaction.followup.messages[-1]
    assert "found no unresolved items and confirmed `1` automatic match" in content
    assert "Confirmed matches this run:" in content
    assert "CREDIT CARD 3333 PAYMENT" in content
    children = getattr(kwargs["view"], "children", [])
    assert len(children) == 1
    assert getattr(children[0], "placeholder", "") == "Unmatch a confirmed transaction"


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
