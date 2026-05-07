from __future__ import annotations

from typing import Callable

from bookiebot.sheets.undo import LoggedAction, action_title
from bookiebot.ui.card import ButtonBase, ButtonStyle, Interaction, ViewBase


class RecentActionButton(ButtonBase):  # type: ignore[misc]
    def __init__(self, label: str, custom_id: str, callback_func: Callable):
        style_name = "danger" if custom_id == "delete" else "secondary"
        style_value = getattr(ButtonStyle, style_name, getattr(ButtonStyle, "primary", ButtonStyle.primary))
        super().__init__(label=label, style=style_value, custom_id=custom_id)
        self.callback_func = callback_func

    async def callback(self, interaction: Interaction):
        await self.callback_func(interaction, self.custom_id)


class RecentActionSelectButton(ButtonBase):  # type: ignore[misc]
    def __init__(self, index: int, action: LoggedAction, callback_func: Callable):
        style_value = getattr(ButtonStyle, "primary", ButtonStyle.primary)
        label = f"{index}. {action_title(action.action)}"
        super().__init__(label=label[:80], style=style_value, custom_id=action.id)
        self.callback_func = callback_func

    async def callback(self, interaction: Interaction):
        await self.callback_func(interaction, self.custom_id)


class RecentActionSelectView(ViewBase):  # type: ignore[misc]
    def __init__(self, actions: list[LoggedAction], callback_func: Callable):
        super().__init__(timeout=120)
        for index, logged in enumerate(actions[:25], start=1):
            self.add_item(RecentActionSelectButton(index, logged, callback_func))


class RecentActionDecisionView(ViewBase):  # type: ignore[misc]
    def __init__(self, callback_func: Callable):
        super().__init__(timeout=120)
        self.add_item(RecentActionButton("Update", "update", callback_func))
        self.add_item(RecentActionButton("Move", "move", callback_func))
        self.add_item(RecentActionButton("Delete", "delete", callback_func))
        self.add_item(RecentActionButton("Cancel", "cancel", callback_func))
