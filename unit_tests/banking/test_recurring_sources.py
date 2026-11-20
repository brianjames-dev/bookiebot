from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
from threading import Event
from unittest.mock import Mock
from bookiebot.banking import service
from bookiebot.sheets.recurring import SUBSCRIPTION_TAB
from bookiebot.sheets.recurring_rows import encode
from unit_tests.sheets.test_recurring import plan
from unit_tests.sheets.test_recurring_storage import B


def test_monthly_source_subscription_has_one_bank_schedule_and_uses_the_wants_column(monkeypatch):
    p = replace(plan(), id="shared_sub_123", kind="subscription", source_tab=SUBSCRIPTION_TAB, name="Xfinity", source_label="Xfinity",
        monthly_source=True, category="subscriptions_wants", version="v1")
    subscriptions = encode([p], SUBSCRIPTION_TAB, [])
    monkeypatch.setattr(service, "_SCHEDULE_SOURCE_CACHE", {})
    monkeypatch.setattr(service, "_read_schedule_source_tabs", lambda *_: (subscriptions, [], [], [["", "Xfinity", "999", "60.23"]]))
    subs, bills = service._schedule_sources_for_actor(B)
    assert subs == []
    assert len(bills) == 1 and bills[0][0].source_range == "billplan:" + p.id
    assert bills[0][1:] == (True, 60.23)


def test_managed_empty_subscription_schedule_never_reverts_to_the_visible_cache(monkeypatch):
    monkeypatch.setattr(service, "_SCHEDULE_SOURCE_CACHE", {})
    monkeypatch.setattr(service, "_read_schedule_source_tabs", lambda *_: (encode([], SUBSCRIPTION_TAB, []), [], [["Old mirror"]], []))
    visible = Mock(side_effect=AssertionError("Do not revive the old cache"))
    monkeypatch.setattr(service, "parse_visible_subscription_schedules", visible)
    subs, bills = service._schedule_sources_for_actor(B)
    assert subs == [] and bills == []
    visible.assert_not_called()


def test_concurrent_reviews_share_one_schedule_values_batch_per_owner(monkeypatch):
    start, release = Event(), Event()
    reads = Mock()
    monkeypatch.setattr(service, "_SCHEDULE_SOURCE_CACHE", {})
    monkeypatch.setattr(service, "_current_month_start", lambda: "2026-11-01")
    monkeypatch.setattr(service, "get_budget_spreadsheet_id_for_user", lambda actor, year: f"{actor}-{year}")
    monkeypatch.setattr(service, "get_gspread_client", object)

    def read_tabs(_client, workbook, titles):
        reads(workbook, titles)
        if workbook == "brian-2026":
            start.set()
            assert release.wait(5)
        return {}

    monkeypatch.setattr(service, "read_workbook_tabs", read_tabs)
    with ThreadPoolExecutor(max_workers=3) as executor:
        first = executor.submit(service._schedule_sources_for_actor, "brian")
        try:
            assert start.wait(5)
            same_owner = executor.submit(service._schedule_sources_for_actor, "brian")
            other_owner = executor.submit(service._schedule_sources_for_actor, "hannah")
            assert other_owner.result(timeout=5) == ([], [])
        finally:
            release.set()
        assert first.result(timeout=5) == same_owner.result(timeout=5) == ([], [])
    titles = [service.SUBSCRIPTION_SCHEDULE_WORKSHEET_TITLE, service.BILL_SCHEDULE_WORKSHEET_TITLE, "Subscriptions", "November"]
    assert [call.args for call in reads.call_args_list] == [("brian-2026", titles), ("hannah-2026", titles)]
    service.clear_schedule_source_cache("brian")
    assert service._schedule_sources_for_actor("brian") == ([], [])
    assert reads.call_count == 3
