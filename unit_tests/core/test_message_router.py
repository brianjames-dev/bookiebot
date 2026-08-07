import pytest
from types import SimpleNamespace
from unittest.mock import AsyncMock

from bookiebot.core.message_router import _action_management_intent
from bookiebot.core.message_router import _bill_payment_intent
from bookiebot.core.message_router import _format_processing_error
from bookiebot.core.message_router import _maybe_typing


class DummyTyping:
    def __init__(self, channel):
        self.channel = channel

    async def __aenter__(self):
        self.channel.typing_enters += 1

    async def __aexit__(self, exc_type, exc, tb):
        self.channel.typing_exits += 1


class TypingChannel:
    def __init__(self):
        self.typing_enters = 0
        self.typing_exits = 0

    def typing(self):
        return DummyTyping(self)


class TypingMessage:
    def __init__(self):
        self.channel = TypingChannel()


@pytest.mark.asyncio
async def test_message_router_maybe_typing_wraps_pre_intent_work():
    message = TypingMessage()

    async with _maybe_typing(message):
        pass

    assert message.channel.typing_enters == 1
    assert message.channel.typing_exits == 1


@pytest.mark.asyncio
async def test_message_router_continues_when_discord_typing_indicator_fails():
    class FailingTyping:
        async def __aenter__(self):
            raise RuntimeError("Discord returned 500")

        async def __aexit__(self, exc_type, exc, tb):
            raise AssertionError("Typing context should not exit after a failed enter")

    message = SimpleNamespace(channel=SimpleNamespace(typing=lambda: FailingTyping()))
    request_processed = False

    async with _maybe_typing(message):
        request_processed = True

    assert request_processed is True


@pytest.mark.asyncio
async def test_message_router_typing_context_does_not_swallow_request_errors():
    message = TypingMessage()

    with pytest.raises(RuntimeError, match="intent parser failed"):
        async with _maybe_typing(message):
            raise RuntimeError("intent parser failed")

    assert message.channel.typing_enters == 1
    assert message.channel.typing_exits == 1


def test_delete_unspecified_expense_routes_to_recent_actions():
    assert _action_management_intent("I need to delete an expense") == (
        "query_recent_actions",
        {"n": 5},
    )


def test_delete_specific_expense_routes_to_targeted_delete():
    assert _action_management_intent("I need to delete the Chipotle expense") == (
        "delete_recent_action",
        {"match_text": "chipotle"},
    )


def test_change_unspecified_expense_routes_to_recent_actions():
    assert _action_management_intent("I need to change a transaction") == (
        "query_recent_actions",
        {"n": 5},
    )


def test_change_specific_expense_without_value_routes_to_update_candidates():
    assert _action_management_intent("I need to change the amount for the Chipotle expense") == (
        "update_recent_action",
        {"match_text": "chipotle", "updates": {}},
    )


def test_move_specific_expense_routes_to_move_action():
    assert _action_management_intent("move the Chipotle expense to food") == (
        "move_recent_action",
        {"category": "food", "match_text": "chipotle"},
    )


def test_change_category_routes_to_move_action():
    assert _action_management_intent("change the category for the Target expense to shopping") == (
        "move_recent_action",
        {"category": "shopping", "match_text": "target"},
    )


def test_selected_transaction_move_followup_routes_to_move_action():
    assert _action_management_intent("move it to food") == (
        "move_recent_action",
        {"category": "food"},
    )


def test_move_specific_expense_to_needs_routes_to_shared_need_category():
    assert _action_management_intent("move the Midas expense to Needs") == (
        "move_recent_action",
        {"category": "need_expenses", "match_text": "midas"},
    )


def test_change_item_name_routes_to_recent_actions():
    assert _action_management_intent("change item name") == (
        "query_recent_actions",
        {"n": 5},
    )


def test_change_last_transaction_item_name_routes_to_recent_actions():
    assert _action_management_intent("change item name of last transaction") == (
        "query_recent_actions",
        {"n": 5},
    )


def test_indexed_move_routes_to_move_action():
    from bookiebot.core.message_router import _indexed_action_intent

    assert _indexed_action_intent("2 move to food") == (
        "move_recent_action",
        {"index": 2, "category": "food"},
    )


def test_split_last_expense_by_income_routes_without_llm():
    assert _action_management_intent("split the last PG&E expense by income") == (
        "split_recent_action",
        {"split_method": "income", "index": 1, "match_text": "pg&e"},
    )


def test_new_logged_expense_with_split_instruction_is_not_mistaken_for_recent_action():
    assert _action_management_intent("log a $100 grocery expense and split by income") is None


@pytest.mark.parametrize(
    ("content", "expected"),
    [
        ("Water bill 148.82", ("log_water_paid", {"amount": 148.82})),
        ("Log Water bill $148.82", ("log_water_paid", {"amount": 148.82})),
        ("Rent 2100 split by income", ("log_rent_paid", {"amount": 2100.0, "split_method": "income"})),
        ("PG&E bill was $95.12", ("log_pge_paid", {"amount": 95.12})),
        ("Recology payment 86", ("log_recology_paid", {"amount": 86.0})),
    ],
)
def test_bill_payments_route_without_llm(content, expected):
    assert _bill_payment_intent(content) == expected


@pytest.mark.parametrize(
    ("content", "expected_intent"),
    [
        ("Did I pay the water bill?", "query_water_paid"),
        ("Have I paid rent?", "query_rent_paid"),
        ("Check whether PG&E was paid", "query_pge_paid"),
        ("Was the trash bill paid?", "query_recology_paid"),
    ],
)
def test_bill_payment_queries_route_without_llm(content, expected_intent):
    assert _bill_payment_intent(content) == (expected_intent, {})


def test_ambiguous_water_purchase_still_uses_llm():
    assert _bill_payment_intent("I bought water for 4.50 at Target") is None


def test_indexed_equal_split_routes_without_llm():
    from bookiebot.core.message_router import _indexed_action_intent

    assert _indexed_action_intent("2 split 50/50") == (
        "split_recent_action",
        {"index": 2, "split_method": "equal"},
    )


def test_reimbursement_commands_route_without_llm():
    from bookiebot.core.message_router import _reimbursement_intent

    assert _reimbursement_intent("What does Hannah owe me?") == ("query_shared_reimbursements", {})
    assert _reimbursement_intent("Hannah reimbursed me for PG&E") == (
        "mark_shared_reimbursement_received",
        {"match_text": "pg&e"},
    )


def test_recent_query_show_more():
    from bookiebot.core.message_router import _recent_query_intent

    assert _recent_query_intent("show more") == (
        "query_recent_actions",
        {"more": True},
    )


def test_recent_query_single_word_routes_without_llm():
    from bookiebot.core.message_router import _recent_query_intent

    assert _recent_query_intent("Recent") == (
        "query_recent_actions",
        {"n": 5},
    )


def test_recent_query_explicit_n_is_preserved():
    from bookiebot.core.message_router import _recent_query_intent

    assert _recent_query_intent("show last 10 transactions") == (
        "query_recent_actions",
        {"n": 10, "explicit_n": True},
    )


def test_recent_query_explicit_n_caps_at_25():
    from bookiebot.core.message_router import _recent_query_intent

    assert _recent_query_intent("show last 30 transactions") == (
        "query_recent_actions",
        {"n": 25, "explicit_n": True},
    )


def test_processing_error_reply_includes_context_for_income():
    reply = _format_processing_error(
        "log_income",
        {"amount": 21.88, "source": "Amazon", "label": "Return"},
        RuntimeError("post-write bookkeeping failed"),
    )

    assert "I hit an error while logging income" in reply
    assert "Request: log_income $21.88 from Amazon (Return)" in reply
    assert "Error: RuntimeError: post-write bookkeeping failed" in reply
    assert "sheet may already have been updated" in reply


def test_bot_identifies_discord_login_rate_limit():
    from bookiebot.core import bot

    assert bot._is_discord_login_rate_limit(Exception("429 You are being rate limited 1015")) is True
    assert (
        bot._is_discord_login_rate_limit(
            Exception("429 Too Many Requests: exceeding global rate limits")
        )
        is True
    )
    assert bot._is_discord_login_rate_limit(Exception("regular startup failure")) is False


def test_bot_login_retry_seconds_has_minimum(monkeypatch):
    from bookiebot.core import bot

    monkeypatch.setenv("BOOKIEBOT_DISCORD_LOGIN_RETRY_SECONDS", "5")
    assert bot._login_retry_seconds() == 60

    monkeypatch.setenv("BOOKIEBOT_DISCORD_LOGIN_RETRY_SECONDS", "abc")
    assert bot._login_retry_seconds() == 300


def test_bot_login_retry_seconds_uses_attempts_and_cap(monkeypatch):
    from bookiebot.core import bot

    monkeypatch.setenv("BOOKIEBOT_DISCORD_LOGIN_RETRY_SECONDS", "100")
    monkeypatch.setenv("BOOKIEBOT_DISCORD_LOGIN_RETRY_MAX_SECONDS", "250")

    assert bot._login_retry_seconds(attempt=1) == 100
    assert bot._login_retry_seconds(attempt=2) == 200
    assert bot._login_retry_seconds(attempt=3) == 250


def test_bot_login_retry_seconds_respects_retry_after(monkeypatch):
    from bookiebot.core import bot

    monkeypatch.setenv("BOOKIEBOT_DISCORD_LOGIN_RETRY_SECONDS", "100")
    monkeypatch.setenv("BOOKIEBOT_DISCORD_LOGIN_RETRY_MAX_SECONDS", "250")

    assert bot._login_retry_seconds(attempt=3, retry_after_seconds=123) == 123
    assert bot._login_retry_seconds(attempt=3, retry_after_seconds=999) == 250
    assert bot._login_retry_seconds(attempt=3, retry_after_seconds=10) == 60


def test_bot_extracts_discord_retry_after_header():
    from bookiebot.core import bot

    exc = Exception("429 Too Many Requests")
    exc.response = SimpleNamespace(headers={"Retry-After": "12.4"})  # type: ignore[attr-defined]

    assert bot._discord_retry_after_seconds(exc) == 13


def test_bot_extracts_retry_after_from_exception_text():
    from bookiebot.core import bot

    exc = Exception("429 Too Many Requests retry_after: 8.2")

    assert bot._discord_retry_after_seconds(exc) == 9


def test_bot_login_retry_sleep_reports_progress(monkeypatch):
    from bookiebot.core import bot

    sleeps: list[float] = []
    now = 0.0

    def fake_sleep(seconds: float) -> None:
        nonlocal now
        sleeps.append(seconds)
        now += seconds

    monkeypatch.setattr(bot, "LOGIN_RETRY_PROGRESS_INTERVAL_SECONDS", 60)

    bot._sleep_before_login_retry(125, sleep_fn=fake_sleep, monotonic_fn=lambda: now)

    assert sleeps == [60, 60, 5]


@pytest.mark.asyncio
async def test_on_message_numeric_reply_reports_expired_pending_selection(monkeypatch):
    import bookiebot.core.message_router as router
    import bookiebot.sheets.undo as undo
    from bookiebot.sheets.routing import resolve_actor_key

    class DummyClient:
        def __init__(self):
            self.user = SimpleNamespace(id=1)
            self.events = {}

        def event(self, func):
            self.events[func.__name__] = func
            return func

    class DummyChannel:
        id = 123
        name = "bookiebot"

        def __init__(self):
            self.sent = []

        async def send(self, content=None, **kwargs):
            self.sent.append((content, kwargs))

    now = 0.0
    monkeypatch.setattr(undo, "_pending_now", lambda: now)
    monkeypatch.setattr(router.config, "CHANNEL_ID", None)
    monkeypatch.setattr(router.config, "CHANNEL_NAME", "bookiebot")
    handle_intent = AsyncMock()
    monkeypatch.setattr(router, "handle_intent", handle_intent)

    client = DummyClient()
    router.register_events(client, SimpleNamespace())

    actor_key = resolve_actor_key(830984827904851969, "hannerish")
    undo.set_pending_delete_selection(actor_key, "expired-action")
    now = 301.0

    message = SimpleNamespace(
        content="1",
        author=SimpleNamespace(id=830984827904851969, name="hannerish"),
        channel=DummyChannel(),
    )

    await client.events["on_message"](message)

    assert message.channel.sent == [("❌ That recent transaction selection expired. Please choose the transaction again.", {})]
    handle_intent.assert_not_awaited()


@pytest.mark.asyncio
async def test_on_message_dm_reply_updates_pending_recent_field(monkeypatch):
    import bookiebot.core.message_router as router
    import bookiebot.sheets.undo as undo
    from bookiebot.sheets.routing import resolve_actor_key

    class DummyClient:
        def __init__(self):
            self.user = SimpleNamespace(id=1)
            self.events = {}

        def event(self, func):
            self.events[func.__name__] = func
            return func

    class DummyDMChannel:
        id = 999
        guild = None

        def __init__(self):
            self.sent = []

        async def send(self, content=None, **kwargs):
            self.sent.append((content, kwargs))

    monkeypatch.setattr(router.config, "CHANNEL_ID", 123)
    handle_intent = AsyncMock()
    monkeypatch.setattr(router, "handle_intent", handle_intent)

    client = DummyClient()
    router.register_events(client, SimpleNamespace())

    actor_key = resolve_actor_key(830984827904851969, "hannerish")
    undo.set_pending_update_field(actor_key, "abc123", "item")

    message = SimpleNamespace(
        content="Coffee beans",
        author=SimpleNamespace(id=830984827904851969, name="hannerish"),
        channel=DummyDMChannel(),
    )

    await client.events["on_message"](message)

    handle_intent.assert_awaited_once_with(
        "update_recent_action",
        {"action_id": "abc123", "updates": {"item": "Coffee beans"}},
        message,
    )


@pytest.mark.asyncio
async def test_on_message_pending_move_item_can_be_canceled(monkeypatch):
    import bookiebot.core.message_router as router
    import bookiebot.sheets.undo as undo
    from bookiebot.sheets.routing import resolve_actor_key

    class DummyClient:
        def __init__(self):
            self.user = SimpleNamespace(id=1)
            self.events = {}

        def event(self, func):
            self.events[func.__name__] = func
            return func

    class DummyDMChannel:
        id = 999
        guild = None

        def __init__(self):
            self.sent = []

        async def send(self, content=None, **kwargs):
            self.sent.append((content, kwargs))

    monkeypatch.setattr(router.config, "CHANNEL_ID", 123)
    handle_intent = AsyncMock()
    monkeypatch.setattr(router, "handle_intent", handle_intent)

    client = DummyClient()
    router.register_events(client, SimpleNamespace())

    actor_key = resolve_actor_key(830984827904851969, "hannerish")
    undo.set_pending_move_item(actor_key, "abc123", "food")

    message = SimpleNamespace(
        content="cancel",
        author=SimpleNamespace(id=830984827904851969, name="hannerish"),
        channel=DummyDMChannel(),
    )

    await client.events["on_message"](message)

    assert message.channel.sent == [("Canceled.", {})]
    assert undo.pending_move_item(actor_key) is None
    handle_intent.assert_not_awaited()


@pytest.mark.asyncio
async def test_on_message_parser_failure_does_not_call_generic_fallback(monkeypatch):
    import bookiebot.core.message_router as router
    from bookiebot.intents.parser import IntentParserError

    class DummyClient:
        def __init__(self):
            self.user = SimpleNamespace(id=1)
            self.events = {}

        def event(self, func):
            self.events[func.__name__] = func
            return func

    class DummyChannel:
        id = 123
        name = "bookiebot"

        def __init__(self):
            self.sent = []

        async def send(self, content=None, **kwargs):
            self.sent.append((content, kwargs))

    monkeypatch.setattr(router.config, "CHANNEL_ID", None)
    monkeypatch.setattr(router.config, "CHANNEL_NAME", "bookiebot")
    monkeypatch.setattr(
        router,
        "parse_message_llm",
        AsyncMock(side_effect=IntentParserError("Intent parsing is temporarily unavailable.")),
    )
    handle_intent = AsyncMock()
    monkeypatch.setattr(router, "handle_intent", handle_intent)

    client = DummyClient()
    router.register_events(client, SimpleNamespace())
    message = SimpleNamespace(
        content="some unsupported request",
        author=SimpleNamespace(id=830984827904851969, name="hannerish"),
        channel=DummyChannel(),
    )

    await client.events["on_message"](message)

    assert message.channel.sent == [
        (
            "❌ BookieBot's intent parser is temporarily unavailable, so I did not make any changes. "
            "Please try again in a moment.",
            {},
        )
    ]
    handle_intent.assert_not_awaited()


@pytest.mark.asyncio
async def test_on_message_water_bill_bypasses_llm(monkeypatch):
    import bookiebot.core.message_router as router

    class DummyClient:
        def __init__(self):
            self.user = SimpleNamespace(id=1)
            self.events = {}

        def event(self, func):
            self.events[func.__name__] = func
            return func

    class DummyChannel:
        id = 123
        name = "bookiebot"

        async def send(self, content=None, **kwargs):
            raise AssertionError(f"Unexpected response: {content}")

    monkeypatch.setattr(router.config, "CHANNEL_ID", None)
    monkeypatch.setattr(router.config, "CHANNEL_NAME", "bookiebot")
    parse_message = AsyncMock(side_effect=AssertionError("LLM should not be called"))
    handle_intent = AsyncMock()
    monkeypatch.setattr(router, "parse_message_llm", parse_message)
    monkeypatch.setattr(router, "handle_intent", handle_intent)

    client = DummyClient()
    router.register_events(client, SimpleNamespace())
    message = SimpleNamespace(
        content="Water bill 148.82",
        author=SimpleNamespace(id=676638528590970917, name="deebers"),
        channel=DummyChannel(),
    )

    await client.events["on_message"](message)

    handle_intent.assert_awaited_once_with("log_water_paid", {"amount": 148.82}, message)
    parse_message.assert_not_awaited()
