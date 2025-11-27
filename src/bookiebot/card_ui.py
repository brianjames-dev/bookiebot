from typing import Any

try:
    import discord  # type: ignore
except ImportError:  # pragma: no cover - runtime fallback for tests without discord.py
    class _SelectOption:
        def __init__(self, label, value):
            self.label = label
            self.value = value

    class _Interaction:
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

    class _View:
        def __init__(self, timeout=None):
            self.timeout = timeout
            self.children = []

        def add_item(self, item):
            self.children.append(item)

    class _Select:
        def __init__(self, placeholder=None, options=None):
            self.placeholder = placeholder
            self.options = options or []
            self.values = []

    class _Button:
        def __init__(self, label=None, style=None, custom_id=None):
            self.label = label
            self.style = style
            self.custom_id = custom_id
            self.view = None

        async def callback(self, interaction):
            return None

    class _DiscordUI:
        Select = _Select
        View = _View
        Button = _Button

    class _Discord:
        SelectOption = _SelectOption
        Interaction = _Interaction
        ui = _DiscordUI()

    discord = _Discord()  # type: Any


class CardSelect(discord.ui.Select):  # type: ignore[misc]
    def __init__(self, callback_func):
        options = [
            discord.SelectOption(label="Brian (BofA)", value="Brian (BofA)"),
            discord.SelectOption(label="Brian (AL)", value="Brian (AL)")
        ]
        super().__init__(placeholder="Select the card used", options=options)
        self.callback_func = callback_func

    async def callback(self, interaction: discord.Interaction):
        await self.callback_func(interaction, self.values[0])

class CardSelectView(discord.ui.View):  # type: ignore[misc]
    def __init__(self, callback_func):
        super().__init__(timeout=60)
        self.add_item(CardSelect(callback_func))


class CardButton(discord.ui.Button):  # type: ignore[misc]
    def __init__(self, label: str, callback_func):
        super().__init__(label=label, style=getattr(discord.ButtonStyle, "primary", 1))
        self.callback_func = callback_func

    async def callback(self, interaction: discord.Interaction):
        await self.callback_func(interaction, self.label)


class CardButtonView(discord.ui.View):  # type: ignore[misc]
    def __init__(self, callback_func):
        super().__init__(timeout=60)
        for label in ["Brian (BofA)", "Brian (AL)"]:
            self.add_item(CardButton(label, callback_func))
