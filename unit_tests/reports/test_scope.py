import pytest

from bookiebot.intents.handlers import _expense_breakdown_persons
from bookiebot.reports.scope import default_expense_report_persons


def test_existing_discord_report_helper_uses_shared_scope():
    assert _expense_breakdown_persons is default_expense_report_persons


@pytest.mark.parametrize("requested", [None, "", "Brian", "  BRIAN  "])
def test_ordinary_brian_report_keeps_its_existing_default_card(requested):
    persons = ["Brian (AL)", "Brian (BofA)"]
    assert default_expense_report_persons("Brian", persons, requested) == ["Brian (BofA)"]
    assert persons == ["Brian (AL)", "Brian (BofA)"]


@pytest.mark.parametrize("owner,persons,requested", [
    ("Brian", ["Brian (BofA)", "Brian (AL)"], "total"),
    ("Brian", ["Brian (BofA)", "Brian (AL)"], "Brian (AL)"),
    ("Brian", ["Brian (AL)"], None),
    ("Brian", ["Brian (BofA)", "Brian (AL)", "Hannah"], "total"),
    ("Hannah", ["Hannah"], None),
    ("Brian", [], None),
])
def test_explicit_and_other_report_scopes_remain_unchanged(owner, persons, requested):
    assert default_expense_report_persons(owner, persons, requested) is persons
