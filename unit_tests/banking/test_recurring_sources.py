from dataclasses import replace
from unittest.mock import Mock
from bookiebot.banking import service
from bookiebot.sheets.routing import sheet_user_context
from bookiebot.sheets.recurring import SUBSCRIPTION_TAB
from bookiebot.sheets.recurring_rows import encode
from unit_tests.sheets.test_recurring import plan
from unit_tests.sheets.test_recurring_storage import B


def test_monthly_source_subscription_has_one_bank_schedule_and_uses_the_wants_column(monkeypatch):
    p = replace(plan(), id="shared_sub_123", kind="subscription", source_tab=SUBSCRIPTION_TAB, name="Xfinity", source_label="Xfinity",
        monthly_source=True, category="subscriptions_wants", version="v1")
    subscriptions = encode([p], SUBSCRIPTION_TAB, [])
    monkeypatch.setattr(service, "_existing_schedule_rows", lambda title: subscriptions if title == SUBSCRIPTION_TAB else [] if title.startswith("_BookieBot") else [["", "Xfinity", "999", "60.23"]])
    with sheet_user_context(B):
        assert service._read_subscription_schedules() == []
        bills = service._read_bill_schedules()
        assert len(bills) == 1 and bills[0].source_range == "billplan:" + p.id
        assert service._bill_amounts_for_schedules(bills)[0][1:] == (True, 60.23)


def test_managed_empty_subscription_schedule_never_reverts_to_the_visible_cache(monkeypatch):
    monkeypatch.setattr(service, "_SCHEDULE_SOURCE_CACHE", {})
    monkeypatch.setattr(service, "_existing_schedule_rows", lambda title: encode([], SUBSCRIPTION_TAB, []) if title == SUBSCRIPTION_TAB else [])
    monkeypatch.setattr(service, "_bill_amounts_for_schedules", lambda bills: [])
    visible = Mock(side_effect=AssertionError("Do not revive the old cache"))
    monkeypatch.setattr(service, "parse_visible_subscription_schedules", visible)
    with sheet_user_context(B):
        subs, bills = service._schedule_sources_for_actor(B)
        assert subs == [] and bills == []
    visible.assert_not_called()
