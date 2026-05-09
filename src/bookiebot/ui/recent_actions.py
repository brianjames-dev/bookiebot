from __future__ import annotations

from typing import Callable

from bookiebot.sheets.undo import LoggedAction, action_option_label, action_title
from bookiebot.ui.card import ButtonBase, ButtonStyle, Interaction, SelectBase, SelectOption, ViewBase


class RecentActionButton(ButtonBase):  # type: ignore[misc]
    def __init__(self, label: str, custom_id: str, callback_func: Callable):
        if custom_id in {"delete", "confirm_delete"}:
            style_name = "danger"
        elif custom_id == "cancel":
            style_name = "secondary"
        else:
            style_name = "primary"
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


class DeleteConfirmView(ViewBase):  # type: ignore[misc]
    def __init__(self, callback_func: Callable):
        super().__init__(timeout=120)
        self.add_item(RecentActionButton("Confirm Delete", "confirm_delete", callback_func))
        self.add_item(RecentActionButton("Cancel", "cancel", callback_func))


class MoveCategoryView(ViewBase):  # type: ignore[misc]
    def __init__(self, callback_func: Callable):
        super().__init__(timeout=120)
        for category in ["Grocery", "Gas", "Food", "Shopping"]:
            self.add_item(RecentActionButton(category, category.lower(), callback_func))


class UpdateFieldView(ViewBase):  # type: ignore[misc]
    def __init__(self, fields: list[str], callback_func: Callable):
        super().__init__(timeout=120)
        labels = {
            "amount": "Amount",
            "item": "Item",
            "location": "Location",
            "person": "Person",
        }
        for field in fields:
            if field in labels:
                self.add_item(RecentActionButton(labels[field], field, callback_func))


class PersonSelect(SelectBase):  # type: ignore[misc]
    def __init__(self, callback_func: Callable):
        options = [
            SelectOption(label="Hannah", value="Hannah"),
            SelectOption(label="Brian (BofA)", value="Brian (BofA)"),
            SelectOption(label="Brian (AL)", value="Brian (AL)"),
        ]
        super().__init__(placeholder="Select person/card", options=options)
        self.callback_func = callback_func

    async def callback(self, interaction: Interaction):
        await self.callback_func(interaction, self.values[0])


class PersonSelectView(ViewBase):  # type: ignore[misc]
    def __init__(self, callback_func: Callable):
        super().__init__(timeout=120)
        self.add_item(PersonSelect(callback_func))
