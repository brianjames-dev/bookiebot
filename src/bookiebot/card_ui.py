try:
    import discord
    from discord.ui import View, Select
except ImportError:  # pragma: no cover - fallback for tests without discord.py
    class _SelectOption:
        def __init__(self, label, value):
            self.label = label
            self.value = value

    class _Interaction:
        pass

    class View:
        def __init__(self, timeout=None):
            self.timeout = timeout

        def add_item(self, item):
            self.item = item

    class Select:
        def __init__(self, placeholder=None, options=None):
            self.placeholder = placeholder
            self.options = options or []
            self.values = []

    class _DiscordUI:
        Select = Select

    class _Discord:
        SelectOption = _SelectOption
        Interaction = _Interaction
        ui = _DiscordUI()

    discord = _Discord()

class CardSelect(discord.ui.Select):
    def __init__(self, callback_func):
        options = [
            discord.SelectOption(label="Brian (BofA)", value="Brian (BofA)"),
            discord.SelectOption(label="Brian (AL)", value="Brian (AL)")
        ]
        super().__init__(placeholder="Select the card used", options=options)
        self.callback_func = callback_func

    async def callback(self, interaction: discord.Interaction):
        await self.callback_func(interaction, self.values[0])

class CardSelectView(View):
    def __init__(self, callback_func):
        super().__init__(timeout=60)
        self.add_item(CardSelect(callback_func))
