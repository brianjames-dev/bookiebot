from __future__ import annotations

from typing import Callable

from bookiebot.sheets.undo import LoggedAction, action_option_label, action_title
from bookiebot.ui.card import ButtonBase, ButtonStyle, Interaction, SelectBase, SelectOption, ViewBase


class RecentActionButton(ButtonBase):  # type: ignore[misc]
    def __init__(self, label: str, custom_id: str, callback_func: Callable):
        style_name = "danger" if custom_id == "delete" else "secondary"
        style_value = getattr(ButtonStyle, style_name, getattr(ButtonStyle, "primary", ButtonStyle.primary))
        super().__init__(label=label, style=style_value, custom_id=custom_id)
        self.callback_func = callback_func

    async def callback(self, interaction: Interaction):
        await self.callback_func(interaction, self.custom_id)


class RecentActionSelect(SelectBase):  # type: ignore[misc]
    def __init__(self, actions: list[LoggedAction], callback_func: Callable):
        options = [
            SelectOption(
                label=f"{index}. {action_title(logged.action)}",
                value=logged.id,
                description=action_option_label(logged.action)[:100],
            )
            for index, logged in enumerate(actions[:25], start=1)
        ]
        super().__init__(placeholder="Select transaction", options=options)
        self.callback_func = callback_func

    async def callback(self, interaction: Interaction):
        await self.callback_func(interaction, self.values[0])


class RecentActionSelectView(ViewBase):  # type: ignore[misc]
    def __init__(self, actions: list[LoggedAction], callback_func: Callable):
        super().__init__(timeout=120)
        self.add_item(RecentActionSelect(actions, callback_func))


class RecentActionDecisionView(ViewBase):  # type: ignore[misc]
    def __init__(self, callback_func: Callable):
        super().__init__(timeout=120)
        self.add_item(RecentActionButton("Update", "update", callback_func))
        self.add_item(RecentActionButton("Move", "move", callback_func))
        self.add_item(RecentActionButton("Delete", "delete", callback_func))
        self.add_item(RecentActionButton("Cancel", "cancel", callback_func))


class MoveCategoryView(ViewBase):  # type: ignore[misc]
    def __init__(self, callback_func: Callable):
        super().__init__(timeout=120)
        for category in ["Grocery", "Gas", "Food", "Shopping"]:
            self.add_item(RecentActionButton(category, category.lower(), callback_func))
