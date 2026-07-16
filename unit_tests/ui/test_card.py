from types import SimpleNamespace

import pytest

from bookiebot.ui.card import CardButton, CardButtonView, _reject_if_not_author


class _Response:
    def __init__(self):
        self.messages = []

    async def send_message(self, content, **kwargs):
        self.messages.append((content, kwargs))


def _interaction(user_id: int):
    return SimpleNamespace(user=SimpleNamespace(id=user_id), response=_Response())


@pytest.mark.asyncio
async def test_reject_if_not_author_blocks_other_users():
    interaction = _interaction(222)
    rejected = await _reject_if_not_author(interaction, "111")
    assert rejected is True
    assert interaction.response.messages
    assert "Only the person who started this" in interaction.response.messages[0][0]


@pytest.mark.asyncio
async def test_reject_if_not_author_allows_owner():
    interaction = _interaction(111)
    rejected = await _reject_if_not_author(interaction, "111")
    assert rejected is False
    assert interaction.response.messages == []


@pytest.mark.asyncio
async def test_card_button_invokes_callback_only_for_author():
    calls = []

    async def callback(interaction, label):
        calls.append((interaction.user.id, label))

    button = CardButton("Brian (BofA)", callback, author_id=111)
    await button.callback(_interaction(222))
    await button.callback(_interaction(111))

    assert calls == [(111, "Brian (BofA)")]


@pytest.mark.asyncio
async def test_card_button_view_binds_author_id():
    view = CardButtonView(lambda *_: None, author_id=999)
    assert all(child.author_id == "999" for child in view.children)
