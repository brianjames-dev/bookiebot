from types import SimpleNamespace

from bookiebot.agent.context import conversation_context_from_message


def _message(*, user_id: int, channel_id: int = 200, guild_id: int | None = 300):
    return SimpleNamespace(
        author=SimpleNamespace(id=user_id, name="deebers", display_name="Brian"),
        channel=SimpleNamespace(id=channel_id),
        guild=SimpleNamespace(id=guild_id) if guild_id is not None else None,
    )


def test_conversation_context_scopes_thread_to_user_and_channel():
    context = conversation_context_from_message(
        _message(user_id=676638528590970917),
    )

    assert context.actor_key == "676638528590970917"
    assert context.discord_user_id == "676638528590970917"
    assert context.channel_id == "200"
    assert context.guild_id == "300"
    assert context.thread_id == "discord:300:200:676638528590970917"


def test_conversation_context_never_shares_memory_between_users():
    brian = conversation_context_from_message(_message(user_id=676638528590970917))
    hannah = conversation_context_from_message(_message(user_id=830984827904851969))

    assert brian.thread_id != hannah.thread_id


def test_dm_conversation_has_an_explicit_dm_scope():
    context = conversation_context_from_message(
        _message(user_id=676638528590970917, guild_id=None),
    )

    assert context.thread_id == "discord:dm:200:676638528590970917"
