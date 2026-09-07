import sys
import threading
from types import ModuleType, SimpleNamespace
from unittest.mock import AsyncMock, Mock

import discord
import pytest

from bookiebot.core import commands
from bookiebot.sheets.routing import APPLE_SHORTCUT_RELAY_USER_ID, UnknownDiscordUserError


@pytest.fixture
def phone_commands():
    client = discord.Client(intents=discord.Intents.none())
    tree = discord.app_commands.CommandTree(client)
    commands.register_commands(tree)
    return {command.name: command for command in tree.get_commands()}


@pytest.fixture
def phone_service(monkeypatch):
    module = ModuleType("bookiebot.reports.phone_app")
    module.create_phone_setup_url = Mock(return_value="https://example.test/app/connect#test-only")
    module.reset_phone_access = Mock()
    monkeypatch.setitem(sys.modules, module.__name__, module)
    return module


@pytest.fixture
def mapped_profiles(monkeypatch):
    def lookup(actor_key):
        if actor_key not in {"111", "222"}:
            raise UnknownDiscordUserError("Unmapped account")
        return SimpleNamespace(name="First" if actor_key == "111" else "Second")

    lookup_mock = Mock(side_effect=lookup)
    monkeypatch.setattr(commands, "get_user_config", lookup_mock)
    return lookup_mock


def interaction(actor_key="111", *, bot=False):
    return SimpleNamespace(
        user=SimpleNamespace(id=actor_key, bot=bot),
        # These alternate identities must never authorize a device or reset.
        message=SimpleNamespace(mentions=[SimpleNamespace(id="222", bot=False)]),
        data={"person": "222"},
        response=SimpleNamespace(send_message=AsyncMock(), defer=AsyncMock()),
        edit_original_response=AsyncMock(),
    )


@pytest.mark.asyncio
@pytest.mark.parametrize("actor_key", ["111", "222"])
async def test_setup_uses_actual_mapped_user_and_returns_only_private_link(phone_commands, phone_service, mapped_profiles, actor_key):
    request = interaction(actor_key)
    event_loop_thread = threading.get_ident()

    def create_url(actor):
        assert threading.get_ident() != event_loop_thread
        request.response.defer.assert_awaited_once_with(ephemeral=True)
        assert actor == actor_key
        return "https://example.test/app/connect#test-only"

    phone_service.create_phone_setup_url.side_effect = create_url
    await phone_commands["expense_app"].callback(request)

    mapped_profiles.assert_called_once_with(actor_key)
    phone_service.create_phone_setup_url.assert_called_once_with(actor_key)
    phone_service.reset_phone_access.assert_not_called()
    request.response.send_message.assert_not_awaited()
    response = request.edit_original_response.await_args.kwargs
    assert "Safari" in response["content"]
    assert "15 minutes" in response["content"]
    assert "Add to Home Screen" in response["content"]
    assert "Already added BookieBot?" in response["content"]
    assert "paste it into the app’s Reconnect screen" in response["content"]
    assert "\n<https://example.test/app/connect#test-only>\n" in response["content"]
    button = response["view"].children[0]
    assert button.label == "Set up BookieBot"
    assert button.style == discord.ButtonStyle.link
    assert button.url == "https://example.test/app/connect#test-only"


@pytest.mark.asyncio
@pytest.mark.parametrize("command_name", ["expense_app", "expense_app_reset"])
@pytest.mark.parametrize("actor_key,bot", [
    ("111", True),
    (APPLE_SHORTCUT_RELAY_USER_ID, False),
    ("shortcut:brian", False),
    ("shortcut:hannah", False),
    ("999", False),
    (None, False),
])
async def test_phone_commands_reject_nonpersonal_or_unmapped_actors(
    phone_commands, phone_service, mapped_profiles, command_name, actor_key, bot,
):
    request = interaction(actor_key, bot=bot)
    await phone_commands[command_name].callback(request)

    phone_service.create_phone_setup_url.assert_not_called()
    phone_service.reset_phone_access.assert_not_called()
    request.response.defer.assert_not_awaited()
    request.response.send_message.assert_awaited_once()
    assert request.response.send_message.await_args.kwargs["ephemeral"] is True
    assert "own Discord account" in request.response.send_message.await_args.args[0]


@pytest.mark.asyncio
@pytest.mark.parametrize("actor_key", ["111", "222"])
async def test_reset_runs_once_for_actual_actor_in_worker_thread(phone_commands, phone_service, mapped_profiles, actor_key):
    request = interaction(actor_key)
    event_loop_thread = threading.get_ident()

    def reset(actor):
        assert threading.get_ident() != event_loop_thread
        request.response.defer.assert_awaited_once_with(ephemeral=True)
        assert actor == actor_key

    phone_service.reset_phone_access.side_effect = reset
    await phone_commands["expense_app_reset"].callback(request)

    phone_service.reset_phone_access.assert_called_once_with(actor_key)
    phone_service.create_phone_setup_url.assert_not_called()
    request.response.send_message.assert_not_awaited()
    content = request.edit_original_response.await_args.kwargs["content"]
    assert "connected phones" in content
    assert "pending setup links" in content
    assert "/expense_app" in content


@pytest.mark.asyncio
@pytest.mark.parametrize("command_name,service_name", [
    ("expense_app", "create_phone_setup_url"),
    ("expense_app_reset", "reset_phone_access"),
])
@pytest.mark.parametrize("failure_at", ["profile", "service"])
async def test_phone_command_errors_stay_private_and_do_not_expose_internal_details(
    phone_commands, phone_service, mapped_profiles, command_name, service_name, failure_at,
):
    request = interaction()
    error = RuntimeError("database-password=secret-test-value")
    if failure_at == "profile":
        mapped_profiles.side_effect = error
    else:
        getattr(phone_service, service_name).side_effect = error

    await phone_commands[command_name].callback(request)

    if failure_at == "profile":
        request.response.defer.assert_not_awaited()
        call = request.response.send_message.await_args
        assert call.kwargs["ephemeral"] is True
        content = call.args[0]
    else:
        request.response.defer.assert_awaited_once_with(ephemeral=True)
        content = request.edit_original_response.await_args.kwargs["content"]
    assert "try again shortly" in content
    assert "secret-test-value" not in content
    assert "database-password" not in content
