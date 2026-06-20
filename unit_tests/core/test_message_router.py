import pytest
from types import SimpleNamespace
from unittest.mock import AsyncMock

from bookiebot.core.message_router import _action_management_intent
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


def test_recent_query_show_more():
    from bookiebot.core.message_router import _recent_query_intent

    assert _recent_query_intent("show more") == (
        "query_recent_actions",
        {"more": True},
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
    assert bot._is_discord_login_rate_limit(Exception("regular startup failure")) is False


def test_bot_login_retry_seconds_has_minimum(monkeypatch):
    from bookiebot.core import bot

    monkeypatch.setenv("BOOKIEBOT_DISCORD_LOGIN_RETRY_SECONDS", "5")
    assert bot._login_retry_seconds() == 60

    monkeypatch.setenv("BOOKIEBOT_DISCORD_LOGIN_RETRY_SECONDS", "abc")
    assert bot._login_retry_seconds() == 900


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
