from __future__ import annotations

import pytest

from bookiebot.splits import requested_split_directive, should_auto_prompt_for_split
from bookiebot.ui.recent_actions import SplitMethodView


@pytest.mark.parametrize(
    ("content", "expected"),
    [
        ("paid PG&E $200 split by income", "income"),
        ("groceries $100 split evenly", "equal"),
        ("groceries $100 50/50", "equal"),
        ("log this and split", "prompt"),
        ("no split on this one", "none"),
        ("ordinary coffee purchase", None),
    ],
)
def test_requested_split_directive(content, expected):
    assert requested_split_directive({}, content) == expected


@pytest.mark.parametrize(
    ("category", "location", "payment", "expected"),
    [
        ("grocery", "Safeway", "", True),
        ("food", "Gameday", "", True),
        ("shopping", "gameday", "", True),
        ("", "", "rent", True),
        ("", "", "PG&E", True),
        ("", "", "water", True),
        ("", "", "recology", True),
        ("", "", "internet", False),
        ("food", "Chipotle", "", False),
    ],
)
def test_automatic_split_prompt_rules(category, location, payment, expected):
    assert should_auto_prompt_for_split(category=category, location=location, payment_label=payment) is expected


@pytest.mark.asyncio
async def test_split_method_buttons_use_approved_labels_and_no_split_is_secondary():
    view = SplitMethodView(lambda *_args: None)

    assert [child.label for child in view.children] == ["By income", "50/50", "No split"]
    assert view.children[-1].style.name == "secondary"
