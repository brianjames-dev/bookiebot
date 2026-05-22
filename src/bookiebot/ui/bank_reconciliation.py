from __future__ import annotations

from collections.abc import Callable

from bookiebot.banking.reconciliation import ActionLogCandidate, ActionLogCandidateGroup
from bookiebot.ui.card import ButtonBase, ButtonStyle, Interaction, SelectBase, SelectOption, ViewBase


class BankReconciliationButton(ButtonBase):  # type: ignore[misc]
    def __init__(self, label: str, action: str, callback_func: Callable, *, custom_id: str | None = None):
        if action == "ignore":
            style_name = "danger"
        elif action in {"fallback", "later", "skip"}:
            style_name = "secondary"
        else:
            style_name = "primary"
        style_value = getattr(ButtonStyle, style_name, getattr(ButtonStyle, "primary", ButtonStyle.primary))
        super().__init__(label=label, style=style_value, custom_id=custom_id or f"bank_reconcile:{action}")
        self.action = action
        self.callback_func = callback_func

    async def callback(self, interaction: Interaction):
        await self.callback_func(interaction, self.action)


class BankReconciliationMatchSelect(SelectBase):  # type: ignore[misc]
    def __init__(
        self,
        options_with_actions: list[tuple[SelectOption, str]],
        callback_func: Callable,
    ):
        super().__init__(
            placeholder="Select a match",
            options=[option for option, _action in options_with_actions],
        )
        self.actions_by_value = {
            option.value: action
            for option, action in options_with_actions
        }
        self.callback_func = callback_func

    async def callback(self, interaction: Interaction):
        await self.callback_func(interaction, self.actions_by_value[self.values[0]])


def _candidate_option(index: int, candidate: ActionLogCandidate) -> tuple[SelectOption, str]:
    source = "schedule" if candidate.action_type == "schedule" else "row"
    label = f"{index}. ${candidate.amount:.2f} {candidate.label}"[:100]
    description = f"{candidate.date:%m-%d} | {source} | conf {candidate.confidence:.2f}"[:100]
    value = f"candidate:{index - 1}"
    return SelectOption(label=label, value=value, description=description), value


def _group_option(index: int, group: ActionLogCandidateGroup) -> tuple[SelectOption, str]:
    label = f"{index}. ${group.total_amount:.2f} grouped rows"[:100]
    description = f"{len(group.candidates)} rows | conf {group.confidence:.2f}"[:100]
    value = f"group:{index - 1}"
    return SelectOption(label=label, value=value, description=description), value


def _single_match_label(action: str, option: SelectOption) -> str:
    amount = option.label.split(" ", 2)[1] if " " in option.label else ""
    if action.startswith("group:"):
        return f"Match grouped rows ({amount})"
    if "schedule" in (option.description or ""):
        return f"Match schedule ({amount})"
    return f"Match row ({amount})"


class BankReconciliationDetailView(ViewBase):  # type: ignore[misc]
    def __init__(
        self,
        candidates: list[ActionLogCandidate],
        groups: list[ActionLogCandidateGroup],
        callback_func: Callable,
        *,
        fallback_available: bool = True,
        session_controls: bool = False,
        pending: bool = False,
    ):
        super().__init__(timeout=600)
        match_options = [
            _group_option(index, group)
            for index, group in enumerate(groups[:5], start=1)
        ]
        match_options.extend(
            _candidate_option(index, candidate)
            for index, candidate in enumerate(candidates[:20], start=1)
        )
        if not pending:
            if len(match_options) == 1:
                option, action = match_options[0]
                self.add_item(BankReconciliationButton(_single_match_label(action, option), action, callback_func))
            elif len(match_options) > 1:
                self.add_item(BankReconciliationMatchSelect(match_options[:25], callback_func))
            self.add_item(BankReconciliationButton("Log", "log", callback_func))
        if session_controls:
            self.add_item(BankReconciliationButton("Skip", "skip", callback_func))
        self.add_item(BankReconciliationButton("Ignore", "ignore", callback_func))
        if fallback_available:
            self.add_item(BankReconciliationButton("Show More", "fallback", callback_func))


class BankReconciliationDigestView(ViewBase):  # type: ignore[misc]
    def __init__(self, callback_func: Callable, *, actor_key: str):
        super().__init__(timeout=None)
        self.add_item(
            BankReconciliationButton(
                "Reconcile Now",
                "start",
                callback_func,
                custom_id=f"bank_reconcile:start:{actor_key}",
            )
        )
        self.add_item(
            BankReconciliationButton(
                "Remind Me Later",
                "later",
                callback_func,
                custom_id=f"bank_reconcile:later:{actor_key}",
            )
        )


class BankReconciliationSnoozeView(ViewBase):  # type: ignore[misc]
    def __init__(self, callback_func: Callable):
        super().__init__(timeout=600)
        self.add_item(BankReconciliationButton("1 hour", "snooze:1h", callback_func))
        self.add_item(BankReconciliationButton("2 hours", "snooze:2h", callback_func))
        self.add_item(BankReconciliationButton("Specific Time", "snooze:specific", callback_func))
        self.add_item(BankReconciliationButton("Tomorrow (same time)", "snooze:tomorrow", callback_func))


class BankReconciliationChangeDefaultView(ViewBase):  # type: ignore[misc]
    def __init__(self, callback_func: Callable):
        super().__init__(timeout=600)
        self.add_item(BankReconciliationButton("Tap Here", "change_default", callback_func))


class BankReconciliationLogChoiceView(ViewBase):  # type: ignore[misc]
    def __init__(self, callback_func: Callable):
        super().__init__(timeout=600)
        self.add_item(BankReconciliationButton("Log as expense", "log:expense", callback_func))
        self.add_item(BankReconciliationButton("Log as income/refund", "log:income", callback_func))


class BankExpenseCategorySelect(SelectBase):  # type: ignore[misc]
    def __init__(self, callback_func: Callable, *, default_category: str):
        options = [
            SelectOption(label=category.title(), value=category, default=category == default_category)
            for category in ["food", "grocery", "gas", "shopping"]
        ]
        super().__init__(placeholder="Select category", options=options)
        self.callback_func = callback_func

    async def callback(self, interaction: Interaction):
        await self.callback_func(interaction, "category", self.values[0], self.view)


class BankExpensePersonSelect(SelectBase):  # type: ignore[misc]
    def __init__(self, callback_func: Callable, *, default_person: str):
        options = [
            SelectOption(label=person, value=person, default=person == default_person)
            for person in ["Hannah", "Brian (BofA)", "Brian (AL)"]
        ]
        super().__init__(placeholder="Select person/card", options=options)
        self.callback_func = callback_func

    async def callback(self, interaction: Interaction):
        await self.callback_func(interaction, "person", self.values[0], self.view)


class BankExpenseFixedFieldsView(ViewBase):  # type: ignore[misc]
    def __init__(
        self,
        field_callback: Callable,
        continue_callback: Callable,
        *,
        default_category: str = "food",
        default_person: str = "Brian (BofA)",
    ):
        super().__init__(timeout=600)
        self.selected_category = default_category
        self.selected_person = default_person
        self.add_item(BankExpenseCategorySelect(field_callback, default_category=default_category))
        self.add_item(BankExpensePersonSelect(field_callback, default_person=default_person))
        self.add_item(BankReconciliationButton("Continue", "continue_log_expense", continue_callback))
