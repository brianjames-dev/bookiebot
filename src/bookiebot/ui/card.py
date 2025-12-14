from typing import Any, TYPE_CHECKING
import os

# Disable discord voice/audio stack to avoid loading audioop (deprecated in Python 3.13)
os.environ.setdefault("DISCORD_AUDIO_DISABLE", "1")

try:
    import discord  # type: ignore
except ImportError:  # pragma: no cover - runtime fallback for tests without discord.py
    discord = None  # type: ignore

if TYPE_CHECKING or discord is not None:
    # Use real discord types when available (or for static typing).
    SelectBase = discord.ui.Select  # type: ignore[attr-defined]
    ViewBase = discord.ui.View  # type: ignore[attr-defined]
    ButtonBase = discord.ui.Button  # type: ignore[attr-defined]
    Interaction = discord.Interaction  # type: ignore[attr-defined]
    SelectOption = discord.SelectOption  # type: ignore[attr-defined]
    ButtonStyle = discord.ButtonStyle  # type: ignore[attr-defined]
else:  # pragma: no cover - test fallback
    class Interaction:
        def __init__(self):
            class _Response:
                async def send_message(self, *args, **kwargs):
                    return None

                async def defer(self, *args, **kwargs):
                    return None

            class _Followup:
                async def send(self, *args, **kwargs):
                    return None

            self.response = _Response()
            self.followup = _Followup()

    class SelectOption:
        def __init__(self, label, value):
            self.label = label
            self.value = value

    class ButtonStyle:
        primary: int = 1

    class SelectBase:
        def __init__(self, placeholder=None, options=None):
            self.placeholder = placeholder
            self.options = options or []
            self.values = []

    class ViewBase:
        def __init__(self, timeout=None):
            self.timeout = timeout
            self.children = []

        def add_item(self, item):
            self.children.append(item)

    class ButtonBase:
        def __init__(self, label=None, style=None, custom_id=None):
            self.label = label
            self.style = style
            self.custom_id = custom_id
            self.view = None

        async def callback(self, interaction):
            return None


class CardSelect(SelectBase):  # type: ignore[misc]
    def __init__(self, callback_func):
        options = [
            SelectOption(label="Brian (BofA)", value="Brian (BofA)"),
            SelectOption(label="Brian (AL)", value="Brian (AL)")
        ]
        super().__init__(placeholder="Select the card used", options=options)
        self.callback_func = callback_func

    async def callback(self, interaction: Interaction):
        await self.callback_func(interaction, self.values[0])

class CardSelectView(ViewBase):  # type: ignore[misc]
    def __init__(self, callback_func):
        super().__init__(timeout=60)
        self.add_item(CardSelect(callback_func))


class CardButton(ButtonBase):  # type: ignore[misc]
    def __init__(self, label: str, callback_func):
        style_value = getattr(ButtonStyle, "primary", ButtonStyle.primary)
        super().__init__(label=label, style=style_value)
        self.callback_func = callback_func

    async def callback(self, interaction: Interaction):
        await self.callback_func(interaction, self.label)


class CardButtonView(ViewBase):  # type: ignore[misc]
    def __init__(self, callback_func):
        super().__init__(timeout=60)
        for label in ["Brian (BofA)", "Brian (AL)"]:
            self.add_item(CardButton(label, callback_func))
