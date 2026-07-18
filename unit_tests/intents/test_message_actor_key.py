from types import SimpleNamespace

from bookiebot.intents.handlers import _message_actor_key
from bookiebot.sheets.routing import APPLE_SHORTCUT_RELAY_USER_ID, DEFAULT_BRIAN_DISCORD_USER_IDS


BRIAN_ID = DEFAULT_BRIAN_DISCORD_USER_IDS[0]


def test_message_actor_key_uses_author_when_non_relay_mentions_user():
    mentioned = SimpleNamespace(id=int(BRIAN_ID), name="brian", bot=False)
    author = SimpleNamespace(id=999001, name="other_user", bot=False)
    message = SimpleNamespace(author=author, mentions=[mentioned])

    assert _message_actor_key(message) == "999001"


def test_message_actor_key_allows_shortcut_relay_mention_override():
    mentioned = SimpleNamespace(id=int(BRIAN_ID), name="brian", bot=False)
    author = SimpleNamespace(id=int(APPLE_SHORTCUT_RELAY_USER_ID), name="shortcut", bot=False)
    message = SimpleNamespace(author=author, mentions=[mentioned])

    assert _message_actor_key(message) == BRIAN_ID


def test_message_actor_key_ignores_bot_mentions_for_relay():
    bot_mention = SimpleNamespace(id=123, name="bookiebot", bot=True)
    author = SimpleNamespace(id=int(APPLE_SHORTCUT_RELAY_USER_ID), name="shortcut", bot=False)
    message = SimpleNamespace(author=author, mentions=[bot_mention])

    assert _message_actor_key(message) == APPLE_SHORTCUT_RELAY_USER_ID
