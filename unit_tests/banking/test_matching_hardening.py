"""Posted-bank checks must use identity and actual evidence, never amount alone."""
from contextlib import nullcontext
from dataclasses import replace
from datetime import date
from pathlib import Path

import pytest

import bookiebot.banking.service as banking_service
from bookiebot.banking.config import BankingConfig
from bookiebot.banking.crypto import TokenCipher
from bookiebot.banking.models import BankTransaction
from bookiebot.banking.plaid_client import PlaidClient
from bookiebot.banking.reconciliation import (
    ScheduledPullCandidate,
    classify_transaction,
    find_action_log_candidates,
    find_scheduled_pull_candidates,
    reconcile_transaction,
)
from bookiebot.banking.service import BankingService
from bookiebot.banking.store import BankStore
from bookiebot.sheets.bills import BillSchedule
from bookiebot.sheets.subscriptions import Subscription
from bookiebot.sheets.undo import LoggedAction, UndoAction


@pytest.fixture(autouse=True)
def current_writer_log_snapshot(monkeypatch):
    # Existing writer tests supply their current-tab action snapshot through the
    # same mocked source; production uses the original current-only reader.
    monkeypatch.setattr(banking_service, "_read_current_logged_actions",
                        lambda actor: banking_service.read_active_logged_actions(actor))


def transaction(name="PG&E WEB PAYMENT", amount=59.96, **changes):
    return replace(BankTransaction(
        id=1, provider_transaction_id="bank-1", owner_key="brian",
        account_name="Checking", account_mask="1234", account_type="depository",
        account_subtype="checking", date="2026-09-12", authorized_date=None,
        name=name, merchant_name=None, amount=amount, pending=False,
        payment_channel=None, updated_at="2026-09-13T00:00:00+00:00",
    ), **changes)


def action(name="PG&E", amount=59.96, *, action_id="logged-1", date_text="9/12/2026", kind="expense"):
    return LoggedAction(
        id=action_id, created_at="2026-09-12T12:00:00", user_key="brian",
        action=UndoAction(
            worksheet="expense", kind="clear_cells", row=12, columns=[1, 2, 3, 4, 5],
            previous_values=["", "", "", "", ""],
            new_values=[date_text, "Bill", str(amount), name, "Brian"],
            metadata={"type": kind, "category": "needs"}, description=f"Logged expense {amount}",
        ),
    )


def pull(name="PG&E", amount=59.96, **changes):
    return replace(ScheduledPullCandidate(
        source_type="bill", name=name, amount=amount,
        pull_date=date(2026, 9, 12), source_ref="Bills!A3:J3", amount_recorded=True,
    ), **changes)


def service(tmp_path):
    config = BankingConfig(plaid_client_id="test", plaid_secret="test", plaid_env="sandbox",
                           token_encryption_key="test", sqlite_path=Path("unused.sqlite3"))
    return BankingService(config, BankStore(tmp_path / "bank.sqlite3", TokenCipher("test")), PlaidClient(config))


@pytest.mark.parametrize("name", [
    "PG&E WEB PAYMENT", "NETFLIX PAYMENT", "STUDENT LOAN PAYMENT", "ACH PAYMENT RECOLOGY",
    "Savings Hardware", "ACH ELECTRONIC CREDIT PAYROLL", "CREDIT CARD PURCHASE NETFLIX",
])
def test_payment_or_bank_words_alone_do_not_resolve_a_charge(name):
    classification, status, *_ = classify_transaction(transaction(name))
    assert status == "needs_review"
    assert classification != "transfer_or_payment"


@pytest.mark.parametrize(("bank_name", "logged_name"), [
    ("PG&E WEB ONLINE", "PGE"), ("P G E ACH PAYMENT", "PG&E"),
    ("PACIFIC GAS AND ELECTRIC", "PG&E"), ("COMCAST CABLE PAYMENT", "Xfinity"),
    ("APPLE.COM/BILL", "Apple iCloud"), ("NETFLIX.COM 99881", "Netflix"),
])
def test_known_aliases_and_punctuation_match_exact_recorded_amount(bank_name, logged_name):
    result = reconcile_transaction(transaction(bank_name), [action(logged_name)])
    assert result.status == "matched"
    assert result.matched_action_log_id == "logged-1"


@pytest.mark.parametrize(("bank_name", "logged_name"), [
    ("Chad's Soup Shack", "Biscuits and Gravy"), ("Pineapple Store", "Apple"),
    ("ONLINE PAYMENT ACME", "ONLINE PAYMENT RECOLOGY"), ("CARD PURCHASE GROCERY", "food expense"),
])
def test_exact_amount_date_without_identity_remains_review(bank_name, logged_name):
    result = reconcile_transaction(transaction(bank_name), [action(logged_name)])
    assert result.status == "needs_review"
    assert result.matched_action_log_id is None


def test_pending_authorization_is_suggested_but_never_finalized():
    pending = transaction(pending=True)
    assert find_action_log_candidates(pending, [action()])
    assert find_scheduled_pull_candidates(pending, [pull()])
    result = reconcile_transaction(pending, [action()], [pull()])
    assert result.status == "needs_review"
    assert result.matched_action_log_id is None
    assert result.matched_sheet_ref is None


def test_ambiguous_same_merchant_and_amount_is_not_arbitrarily_linked():
    duplicate = action(action_id="logged-2", date_text="9/11/2026")
    result = reconcile_transaction(transaction(), [action(), duplicate])
    assert result.status == "needs_review"
    assert len(find_action_log_candidates(transaction(), [action(), duplicate])) == 2


def test_one_cent_difference_is_review_only():
    result = reconcile_transaction(transaction(amount=59.97), [action()], [pull()])
    assert result.status == "needs_review"
    assert find_action_log_candidates(transaction(amount=59.97), [action()])


def test_authorization_day_survives_delayed_posting():
    result = reconcile_transaction(transaction(date="2026-09-22", authorized_date="2026-09-12"), [action()])
    assert result.status == "matched"


@pytest.mark.parametrize("authorized", ["2026-10-01", "2026-01-01", "not-a-date"])
def test_impossible_authorization_date_cannot_extend_match_window(authorized):
    result = reconcile_transaction(transaction(date="2026-09-22", authorized_date=authorized), [action()])
    assert result.status == "needs_review"


def test_subscription_occurrences_match_independently_across_months():
    september = pull("Netflix", 19.99, source_type="subscription", amount_recorded=False)
    october = replace(september, pull_date=date(2026, 10, 12))
    first = reconcile_transaction(transaction("Netflix", 19.99), scheduled_pulls=[september, october])
    second = reconcile_transaction(transaction("Netflix", 19.99, date="2026-10-12"),
                                   scheduled_pulls=[september, october],
                                   excluded_sheet_refs={first.matched_sheet_ref or ""})
    assert first.status == second.status == "matched"
    assert first.matched_sheet_ref != second.matched_sheet_ref
    assert second.matched_sheet_ref == "Bills!A3:J3#pull=2026-10-12"
    repeat = reconcile_transaction(transaction("Netflix", 19.99), scheduled_pulls=[september],
                                   excluded_sheet_refs={first.matched_sheet_ref or ""})
    assert repeat.status == "needs_review"


def test_bill_one_monthly_row_cannot_be_reused_on_another_day():
    first = pull()
    later_hint = replace(first, pull_date=date(2026, 9, 16))
    assert first.occurrence_ref == later_hint.occurrence_ref
    result = reconcile_transaction(transaction(), scheduled_pulls=[first, later_hint])
    assert result.status == "matched"
    duplicate = reconcile_transaction(transaction(date="2026-09-16"), scheduled_pulls=[later_hint],
                                      excluded_sheet_refs={result.matched_sheet_ref or ""})
    assert duplicate.status == "needs_review"


def test_unrecorded_bill_expectation_is_only_a_suggestion():
    expected = pull("Student Loan", amount_recorded=False)
    bank = transaction("Student Loan Payment")
    assert reconcile_transaction(bank, scheduled_pulls=[expected]).status == "needs_review"
    candidate = find_scheduled_pull_candidates(bank, [expected])[0]
    assert not candidate.amount_recorded
    assert "not logged" in candidate.notes


def test_unknown_amount_needs_a_real_bill_name():
    assert find_scheduled_pull_candidates(transaction("Coffee shop"), [pull(amount=0)]) == []
    assert find_scheduled_pull_candidates(transaction(), [pull(amount=0)])


def test_ambiguous_subscription_brand_does_not_choose_one_schedule():
    one = pull("Apple iCloud", 9.99, source_type="subscription")
    two = pull("Apple Music", 9.99, source_type="subscription", source_ref="Subscriptions!A4:C4")
    assert reconcile_transaction(transaction("APPLE.COM/BILL", 9.99), scheduled_pulls=[one, two]).status == "needs_review"


def setup_sources(monkeypatch, bill, *, recorded=True, amount=59.96):
    banking_service.clear_schedule_source_cache()
    monkeypatch.setattr(banking_service, "_current_month_start", lambda: "2026-09-01")
    monkeypatch.setattr(banking_service, "sheet_user_context", lambda _actor: nullcontext())
    monkeypatch.setattr(banking_service, "_read_subscription_schedules", lambda: [])
    monkeypatch.setattr(banking_service, "parse_visible_subscription_schedules", lambda: [])
    monkeypatch.setattr(banking_service, "_read_bill_schedules", lambda: [bill])
    monkeypatch.setattr(banking_service, "_bill_amounts_for_schedules", lambda bills: [(bill, recorded, amount) for bill in bills])


def test_recorded_bill_amount_does_not_leak_to_other_months(monkeypatch):
    bill = BillSchedule("loan", "Student Loan", "monthly", 12, source_label="Student Loan", expected_amount=59.96)
    setup_sources(monkeypatch, bill, amount=119.92)
    for month, amount, recorded in [(8, 59.96, False), (9, 119.92, True), (10, 59.96, False)]:
        candidates = banking_service._scheduled_pulls_for_transactions(
            [transaction("Student Loan", date=f"2026-{month:02}-12")], actor_key="brian")
        assert candidates
        assert all(p.amount == amount and p.amount_recorded is recorded for p in candidates)


def test_failed_schedule_read_is_not_cached_as_empty_for_fifteen_minutes(monkeypatch):
    bill = BillSchedule("pge", "PG&E", "monthly", 12)
    setup_sources(monkeypatch, bill)
    reads = []
    def subscriptions():
        reads.append(1)
        if len(reads) == 1:
            raise RuntimeError("temporary timeout")
        return [Subscription(name="Netflix", amount=19.99, cadence="monthly", pull_day=12)]
    monkeypatch.setattr(banking_service, "_read_subscription_schedules", subscriptions)
    with pytest.raises(RuntimeError, match="source data is temporarily unavailable"):
        banking_service._scheduled_pulls_for_transactions([transaction()], actor_key="brian")
    second = banking_service._scheduled_pulls_for_transactions([transaction()], actor_key="brian")
    assert any(p.name == "Netflix" for p in second)
    assert len(reads) == 2


def test_confirm_cannot_turn_expected_bill_into_recorded_expense(monkeypatch, tmp_path):
    bank_service = service(tmp_path)
    bank_service.seed_unmatched_debug_transaction("brian", name="PG&E PAYMENT", amount=59.96, date="2026-09-12")
    monkeypatch.setattr(banking_service, "_scheduled_pulls_for_transactions", lambda *_a, **_k: [pull(amount_recorded=False)])
    monkeypatch.setattr(banking_service, "read_active_logged_actions", lambda *_a: [])
    item = bank_service.reconciliation_preview("brian", actor_key="brian").items[0]
    _item, candidate, status = bank_service.confirm_reconciliation_schedule_match(
        "brian", item.id, actor_key="brian", schedule_ref=pull().occurrence_ref,
    )
    assert status == "bill_not_recorded"
    assert candidate and not candidate.amount_recorded
    saved = bank_service.get_reconciliation_item("brian", item.id)
    assert saved is not None and saved.status == "needs_review"


def test_bill_sources_read_the_budget_once_for_all_schedules(monkeypatch):
    from types import SimpleNamespace
    reads = []
    def rows():
        reads.append(1)
        return [["PG&E", "59.96"], ["Water", "42.10"], ["Student Loan", "0"]]
    monkeypatch.setattr(banking_service, "get_existing_personal_worksheet",
                        lambda _title: SimpleNamespace(get_all_values=rows))
    bills = [BillSchedule(label, label, "monthly", 12, source_label=label)
             for label in ["PG&E", "Water", "Student Loan"]]
    result = banking_service._bill_amounts_for_schedules(bills)
    assert [(entered, amount) for _bill, entered, amount in result] == [(True, 59.96), (True, 42.10), (False, 0)]
    assert len(reads) == 1


def test_force_preview_cannot_borrow_a_confirmed_row(monkeypatch, tmp_path):
    bank_service = service(tmp_path)
    monkeypatch.setattr(banking_service, "read_active_logged_actions", lambda *_a: [action()])
    monkeypatch.setattr(banking_service, "_scheduled_pulls_for_transactions", lambda *_a, **_k: [])
    bank_service.seed_unmatched_debug_transaction("brian", name="PG&E PAYMENT", amount=59.96, date="2026-09-12")
    first = bank_service.reconciliation_preview("brian", actor_key="brian").items[0]
    confirmed = bank_service.confirm_reconciliation_item(
        "brian", first.id, matched_action_log_id="logged-1", matched_sheet_ref="expense!row 12#month=2026-09", notes="User checked",
    )
    assert confirmed is not None
    bank_service.seed_unmatched_debug_transaction("brian", name="PG&E PAYMENT", amount=59.96, date="2026-09-13")
    preview = bank_service.reconciliation_preview("brian", actor_key="brian", force=True)
    original = next(item for item in preview.items if item.id == first.id)
    duplicate = next(item for item in preview.items if item.id != first.id)
    assert original.status == "confirmed"
    assert original.matched_action_log_id == "logged-1"
    assert original.notes == confirmed.notes
    assert duplicate.status == "needs_review"
    assert duplicate.matched_action_log_id is None


def test_numeric_item_name_is_not_the_logged_expense_amount():
    logged = action()
    logged.action.new_values[1] = "3"
    assert reconcile_transaction(transaction(), [logged]).status == "matched"
    assert reconcile_transaction(transaction(amount=3), [logged]).status == "needs_review"


@pytest.mark.parametrize("source_type", ["bill", "subscription"])
def test_duplicate_charge_cannot_use_schedule_after_its_logged_action(source_type):
    scheduled = pull(source_type=source_type)
    logged = action()
    first = reconcile_transaction(transaction(), [logged], [scheduled])
    assert first.matched_action_log_id == logged.id
    assert first.matched_sheet_ref == f"expense!row 12#month=2026-09 + {scheduled.occurrence_ref}"
    duplicate = reconcile_transaction(transaction(), [logged], [scheduled], excluded_action_ids={logged.id})
    assert duplicate.status == "needs_review"
    assert duplicate.matched_sheet_ref is None
    assert find_scheduled_pull_candidates(transaction(), [scheduled], action_log=[logged]) == []


def test_ambiguous_logged_rows_cannot_fall_back_to_the_same_schedule():
    result = reconcile_transaction(transaction(), [action(), action(action_id="other")], [pull()])
    assert result.status == "needs_review"


def test_phone_and_discord_candidates_do_not_offer_reserved_action_as_schedule(monkeypatch, tmp_path):
    bank_service = service(tmp_path)
    monkeypatch.setattr(banking_service, "read_active_logged_actions", lambda *_a: [action()])
    monkeypatch.setattr(banking_service, "_scheduled_pulls_for_transactions", lambda *_a, **_k: [pull()])
    bank_service.seed_unmatched_debug_transaction("brian", name="PG&E PAYMENT", amount=59.96, date="2026-09-12")
    first = bank_service.reconciliation_preview("brian", actor_key="brian").items[0]
    assert first.matched_action_log_id == "logged-1"
    bank_service.seed_unmatched_debug_transaction("brian", name="PG&E PAYMENT", amount=59.96, date="2026-09-13")
    second = bank_service.reconciliation_preview("brian", actor_key="brian").items[0]
    assert second.status == "needs_review"
    _, candidates, _ = bank_service.reconciliation_match_candidates("brian", second.id, actor_key="brian")
    assert candidates == []
    _, _, status = bank_service.confirm_reconciliation_schedule_match(
        "brian", second.id, actor_key="brian", schedule_ref=pull().occurrence_ref,
    )
    assert status == "schedule_not_found"


def test_new_action_cannot_reuse_already_checked_schedule():
    result = reconcile_transaction(transaction(), [action()], [pull()], excluded_sheet_refs={pull().occurrence_ref})
    assert result.status == "needs_review"
    assert result.matched_action_log_id is None


def test_reserved_schedule_excludes_new_action_but_allows_same_bank_proof_change(monkeypatch, tmp_path):
    bank_service = service(tmp_path)
    actions = []
    monkeypatch.setattr(banking_service, "read_active_logged_actions", lambda *_a: actions)
    monkeypatch.setattr(banking_service, "_scheduled_pulls_for_transactions", lambda *_a, **_k: [pull()])
    bank_service.seed_unmatched_debug_transaction("brian", name="PG&E PAYMENT", amount=59.96, date="2026-09-12")
    first = bank_service.reconciliation_preview("brian", actor_key="brian").items[0]
    assert first.matched_sheet_ref == pull().occurrence_ref
    actions.append(action())
    bank_service.seed_unmatched_debug_transaction("brian", name="PG&E PAYMENT", amount=59.96, date="2026-09-13")
    second = bank_service.reconciliation_preview("brian", actor_key="brian").items[0]
    assert second.status == "needs_review"
    _, candidates, _ = bank_service.reconciliation_match_candidates("brian", second.id, actor_key="brian")
    assert candidates == []
    _, _, status = bank_service.confirm_reconciliation_action_match("brian", second.id, actor_key="brian", action_id="logged-1")
    assert status == "already_matched"
    _, own_candidates, _ = bank_service.reconciliation_match_candidates("brian", first.id, actor_key="brian")
    assert [candidate.action_id for candidate in own_candidates] == ["logged-1"]
    changed, _, status = bank_service.confirm_reconciliation_action_match("brian", first.id, actor_key="brian", action_id="logged-1")
    assert status == "matched"
    assert changed and changed.matched_action_log_id == "logged-1"


def test_action_candidates_keep_physical_row_and_schedule_claim_together(monkeypatch, tmp_path):
    bank_service = service(tmp_path)
    logged = action()
    monkeypatch.setattr(banking_service, "read_active_logged_actions", lambda *_a: [logged])
    monkeypatch.setattr(banking_service, "_scheduled_pulls_for_transactions", lambda *_a, **_k: [pull()])
    bank = bank_service.seed_unmatched_debug_transaction("brian", name="PG&E PAYMENT", amount=59.96, date="2026-09-12")
    item = bank_service.store.upsert_reconciliation_item(
        owner_key="brian", transaction=bank, classification="expense", status="needs_review", confidence=0,
    )
    _, candidates, _ = bank_service.reconciliation_match_candidates("brian", item.id, actor_key="brian")
    assert len(candidates) == 1
    ref = candidates[0].sheet_ref
    assert ref == f"expense!row 12#month=2026-09 + {pull().occurrence_ref}"
    assert banking_service._find_action_for_sheet_ref([logged], ref) == logged
    confirmed, candidate, status = bank_service.confirm_reconciliation_action_match(
        "brian", item.id, actor_key="brian", action_id=logged.id,
    )
    assert status == "matched"
    assert candidate and candidate.sheet_ref == ref
    assert confirmed and confirmed.matched_sheet_ref == ref


def test_missing_schedule_sources_stay_absent_without_provisioning(monkeypatch):
    from gspread.exceptions import WorksheetNotFound
    def absent(_title):
        raise WorksheetNotFound("not configured")
    monkeypatch.setattr(banking_service, "get_existing_personal_worksheet", absent)
    assert banking_service._read_subscription_schedules() == []
    assert banking_service._read_bill_schedules() == []


def test_missing_visible_fallback_is_optional_but_not_a_failed_check(monkeypatch):
    from contextlib import nullcontext
    from gspread.exceptions import WorksheetNotFound
    def absent(*args):
        raise WorksheetNotFound("not configured")
    banking_service.clear_schedule_source_cache()
    monkeypatch.setattr(banking_service, "sheet_user_context", lambda *_: nullcontext())
    monkeypatch.setattr(banking_service, "get_existing_personal_worksheet", absent)
    monkeypatch.setattr(banking_service, "parse_visible_subscription_schedules", absent)
    try:
        assert banking_service._schedule_sources_for_actor("brian") == ([], [])
    finally:
        banking_service.clear_schedule_source_cache()


def test_source_access_error_is_not_treated_as_missing_or_provisioned(monkeypatch):
    def unavailable(_title):
        raise RuntimeError("temporary API error")
    monkeypatch.setattr(banking_service, "get_existing_personal_worksheet", unavailable)
    with pytest.raises(RuntimeError, match="temporary API error"):
        banking_service._read_subscription_schedules()
    with pytest.raises(RuntimeError, match="temporary API error"):
        banking_service._read_bill_schedules()


def action_row(logged):
    import json
    from dataclasses import asdict
    return [logged.id, logged.created_at, logged.user_key or "", logged.status, "", json.dumps(asdict(logged.action))]


def test_action_history_crosses_month_and_year_without_provisioning(monkeypatch):
    from datetime import datetime
    from bookiebot.sheets.routing import PACIFIC_TZ
    monkeypatch.setattr(banking_service, "now_pacific", lambda: datetime(2027, 1, 3, tzinfo=PACIFIC_TZ))
    monkeypatch.setattr(banking_service, "get_gspread_client", object)
    monkeypatch.setattr(banking_service, "get_shared_expenses_spreadsheet_id", lambda year: f"shared-{year}")
    monkeypatch.setattr(banking_service, "actor_key_aliases", lambda actor: {actor, "brian-discord"})
    december = action("PG&E", action_id="december", date_text="12/31/2026")
    january = action("Coffee", action_id="january", date_text="1/2/2027")
    foreign = replace(december, id="foreign", user_key="hannah")
    undone = replace(january, id="undone", status="undone")
    calls = []
    def batch(_client, workbook, titles):
        calls.append((workbook, titles))
        if workbook == "shared-2026":
            return {"_BookieBot Action Log - 2026-12": [banking_service._LOG_HEADERS, action_row(december), action_row(foreign)]}
        return {"_BookieBot Action Log - 2027-01": [banking_service._LOG_HEADERS, action_row(january), action_row(undone)]}
    monkeypatch.setattr(banking_service, "read_workbook_tabs", batch)
    result = banking_service.read_active_logged_actions("brian")
    assert [logged.id for logged in result] == ["december", "january"]
    assert len(calls) == 2
    assert sum(len(titles) for _, titles in calls) <= 4
    bank = transaction("PG&E", date="2027-01-03", authorized_date="2026-12-31")
    matched = reconcile_transaction(bank, result)
    assert matched.matched_action_log_id == "december"
    assert matched.matched_sheet_ref == "expense!row 12#month=2026-12"


@pytest.mark.parametrize("failure", ["quota", "malformed"])
def test_action_history_failure_does_not_become_empty_evidence(monkeypatch, failure):
    monkeypatch.setattr(banking_service, "get_gspread_client", object)
    monkeypatch.setattr(banking_service, "get_shared_expenses_spreadsheet_id", lambda _year: "shared")
    monkeypatch.setattr(banking_service, "actor_key_aliases", lambda actor: {actor})
    def batch(*_args):
        if failure == "quota":
            raise RuntimeError("API unavailable")
        return {"Action Log": [["wrong", "headers"]]}
    monkeypatch.setattr(banking_service, "read_workbook_tabs", batch)
    with pytest.raises((RuntimeError, ValueError)):
        banking_service.read_active_logged_actions("brian")


def test_transient_source_failure_preserves_previous_automatic_match(monkeypatch, tmp_path):
    bank_service = service(tmp_path)
    monkeypatch.setattr(banking_service, "read_active_logged_actions", lambda *_a: [action()])
    monkeypatch.setattr(banking_service, "_scheduled_pulls_for_transactions", lambda *_a, **_k: [pull()])
    bank_service.seed_unmatched_debug_transaction("brian", name="PG&E PAYMENT", amount=59.96, date="2026-09-12")
    previous = bank_service.reconciliation_preview("brian", actor_key="brian").items[0]
    def fail(*_args, **_kwargs):
        raise RuntimeError("temporary source failure")
    monkeypatch.setattr(banking_service, "_scheduled_pulls_for_transactions", fail)
    with pytest.raises(RuntimeError):
        bank_service.reconciliation_preview("brian", actor_key="brian", force=True)
    assert bank_service.get_reconciliation_item("brian", previous.id) == previous


def test_source_row_fallback_does_not_resolve_same_row_in_wrong_month():
    assert banking_service._find_action_for_sheet_ref([action()], "expense!row 12#month=2026-08") is None
