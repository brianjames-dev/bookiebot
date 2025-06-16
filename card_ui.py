import discord
from discord.ui import View, Select

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
