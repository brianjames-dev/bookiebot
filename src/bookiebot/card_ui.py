from typing import Any, TYPE_CHECKING

if TYPE_CHECKING:
    import discord
else:  # pragma: no cover - runtime fallback for tests without discord.py
    class _SelectOption:
        def __init__(self, label, value):
            self.label = label
            self.value = value

    class _Interaction:
        pass

    class _View:
        def __init__(self, timeout=None):
            self.timeout = timeout

        def add_item(self, item):
            self.item = item

    class _Select:
        def __init__(self, placeholder=None, options=None):
            self.placeholder = placeholder
            self.options = options or []
            self.values = []

    class _DiscordUI:
        Select = _Select
        View = _View

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
