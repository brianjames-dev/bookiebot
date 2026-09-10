from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

from bookiebot.core import message_router as router
from bookiebot.intents import handlers
from bookiebot.intents.student_loans import LOG_STUDENT_LOAN, QUERY_STUDENT_LOAN
from bookiebot.sheets import student_loans as loans
from bookiebot.sheets.bills import BILL_SCHEDULE_HEADERS
from bookiebot.sheets.routing import (
    SheetRoutingError, get_current_discord_user_id, sheet_user_context,
    spreadsheet_read_quota_error,
)
from unit_tests.support.sheets_repo_stub import SheetsRepoStub
from unit_tests.reimbursements.test_projection import Book

BRIAN = "676638528590970917"
HANNAH = "830984827904851969"
SCHEDULE = ["student_loan", "Student Loan", "monthly", "12", "", "Student Loan", "", "", "", "59"]


def repo_for(*, schedules=None, rows=None):
    repo = SheetsRepoStub(bill_schedule_rows=[BILL_SCHEDULE_HEADERS, *(schedules if schedules is not None else [SCHEDULE])])
    book = Book()
    repo.income = book.add_sheet("September", rows if rows is not None else [["", "Student Loan", ""]])
    repo.income.spreadsheet = book
    return repo


def message_for(content, actor=BRIAN, **extra):
    return SimpleNamespace(content=content, author=SimpleNamespace(id=int(actor), name="deebers" if actor == BRIAN else "hannerish"),
                           channel=SimpleNamespace(guild=None, id=123, name="bookiebot", send=AsyncMock()), **extra)


@pytest.mark.parametrize("content", [
    "Log student loan $59", "I paid 59 for student loan", "I paid $59 for my student loan",
    "Please record $59 student loan", "Can you log my student loan $59?", "Paid student-loan 59 today",
])
def test_affirmative_loan_commands(content):
    assert router._bill_payment_intent(content) == (LOG_STUDENT_LOAN, {"amount": 59.0})


@pytest.mark.parametrize("content", ["Did I pay my student loan?", "Check student loan status", "Was the student loan paid?"])
def test_loan_status_commands(content):
    assert router._bill_payment_intent(content) == (QUERY_STUDENT_LOAN, {})


@pytest.mark.parametrize("content", [
    "I haven't paid student loan $59", "Do not log student loan $59", "I will pay student loan $59 tomorrow",
    "Could I pay $59 for student loan?", "Student loan $59?", "Log Hannah's student loan $59",
    "Hannah paid $59 for student loan", "Did Hannah pay her student loan?", "Log student loan $59 next month",
    "Log student loan $59 yesterday", "Log student loan $59 split by income", "What is my student loan?",
    "My student loan will be 59", "Student loan autopay 59", "Log student loan $59.999",
])
@pytest.mark.asyncio
async def test_non_commands_do_not_reach_parser_or_pending_writes(monkeypatch, content):
    class Client:
        user = SimpleNamespace(id=1)

        def event(self, fn):
            setattr(self, fn.__name__, fn)
            return fn

    client = Client()
    router.register_events(client, SimpleNamespace())
    parser = AsyncMock(side_effect=AssertionError("No LLM mutation routing"))
    conversation = AsyncMock()
    monkeypatch.setattr(router, "parse_message_llm", parser)
    monkeypatch.setattr(handlers, "fallback_handler", conversation)
    monkeypatch.setattr(router, "pending_update_field", lambda actor: ("existing", "amount"))
    monkeypatch.setattr(handlers, "update_recent_action", MagicMock(side_effect=AssertionError("No pending write")))
    monkeypatch.setattr(handlers, "log_standalone_student_loan", MagicMock(side_effect=AssertionError("No loan write")))
    await client.on_message(message_for(content))
    parser.assert_not_awaited()
    conversation.assert_awaited_once()


def test_configured_payment_uses_exact_row_and_preserves_undo(monkeypatch):
    repo = repo_for(rows=[["", "Student Loan Extra", "999"], ["", "Student Loan", "12.00"]])
    record = MagicMock(return_value="loan-action")
    monkeypatch.setattr(loans, "record_undo_action", record)
    with repo.patched(), sheet_user_context(BRIAN):
        assert loans.student_loan_status()["amount"] == 12
        assert loans.log_standalone_student_loan(59, return_action_id=True) == (True, "loan-action")
        assert loans.student_loan_status()["amount"] == 59
    assert repo.income.get_all_values() == [["", "Student Loan Extra", "999"], ["", "Student Loan", 59.0]]
    actor, action = record.call_args.args
    assert actor == BRIAN
    assert action.row == 2 and action.columns == [3]
    assert action.previous_values == ["12.00"] and action.new_values == ["59.00"]
    assert action.metadata == {"type": "payment", "category": "Student Loan", "exact_source_label": "Student Loan"}


@pytest.mark.parametrize("schedules,rows", [
    ([SCHEDULE, SCHEDULE], [["", "Student Loan", ""]]),
    ([SCHEDULE], [["", "Student Loan", ""], ["", "Student Loan", ""]]),
    ([SCHEDULE], [["", "Student Loan Payment", ""]]),
    ([SCHEDULE], [["", "Student Loan Extra", ""]]),
    ([SCHEDULE], [["Student Loan", "", ""]]),
    ([SCHEDULE[:-1] + ["invalid"]], [["", "Student Loan", ""]]),
])
def test_invalid_or_ambiguous_config_never_writes(schedules, rows):
    repo = repo_for(schedules=schedules, rows=rows)
    before = repo.income.get_all_values()
    with repo.patched(), sheet_user_context(BRIAN), pytest.raises(SheetRoutingError):
        loans.log_standalone_student_loan(59)
    assert repo.income.get_all_values() == before


@pytest.mark.parametrize("schedules", [[], [SCHEDULE[:9]], [SCHEDULE[:-1] + [""]]])
def test_legacy_and_unconfigured_remain_subscription_only(schedules):
    repo = repo_for(schedules=schedules)
    with repo.patched(), sheet_user_context(HANNAH):
        status = loans.student_loan_status()
        assert status["configured"] is False and "subscription autopay" in status["note"]
        with pytest.raises(SheetRoutingError, match="subscription autopay"):
            loans.log_standalone_student_loan(59)
    assert repo.income.get_all_values()[0][2] == ""
    assert repo.bill_schedule.update_calls == 0


@pytest.mark.parametrize("amount", [None, 0, -59, "NaN", "Infinity", "59.999", "1000000001"])
def test_invalid_amounts_never_write(amount):
    repo = repo_for()
    with repo.patched(), sheet_user_context(BRIAN), pytest.raises(SheetRoutingError):
        loans.log_standalone_student_loan(amount)
    assert repo.income.get_all_values()[0][2] == ""


def test_schedule_does_not_fill_actual_on_read():
    repo = repo_for()
    with repo.patched(), sheet_user_context(BRIAN):
        assert loans.student_loan_status() == {
            "configured": True, "label": "Student Loan", "amount": 0.0, "paid": False,
            "expectedAmount": 59.0, "pullDay": 12,
            "note": "Recorded current-month payment; a schedule alone does not confirm a payment.",
        }
    assert repo.income.get_all_values()[0][2] == ""


@pytest.mark.asyncio
async def test_author_scope_and_literal_amount_over_model_amount(monkeypatch):
    logged = []
    def log(amount, *, return_action_id):
        logged.append((get_current_discord_user_id(), amount))
        return True, "action"
    monkeypatch.setattr(handlers, "log_standalone_student_loan", log)
    message = message_for("Log student loan $59")
    await handlers.handle_intent(LOG_STUDENT_LOAN, {"amount": 9000}, message)
    assert logged == [(BRIAN, 59)]
    assert "$59.00" in message.channel.send.call_args.args[0]


@pytest.mark.parametrize("entities,mentions", [
    ({"person": "Hannah"}, []), ({"owner_key": "hannah"}, []), ({"owner": "Hannah"}, []),
    ({"actor_key": HANNAH}, []), ({}, [SimpleNamespace(id=int(HANNAH), name="hannerish", bot=False)]),
    ({"persons": ["Hannah"]}, []), ({"budget_owner_key": "hannah"}, []),
])
@pytest.mark.asyncio
async def test_foreign_identity_never_reads_or_writes(monkeypatch, entities, mentions):
    log = MagicMock(side_effect=AssertionError("No write"))
    monkeypatch.setattr(handlers, "log_standalone_student_loan", log)
    await handlers.handle_intent(LOG_STUDENT_LOAN, {"amount": 59, **entities}, message_for("Log student loan $59", mentions=mentions))
    log.assert_not_called()


@pytest.mark.asyncio
async def test_direct_model_intent_cannot_override_non_command(monkeypatch):
    log = MagicMock(side_effect=AssertionError("No write"))
    monkeypatch.setattr(handlers, "log_standalone_student_loan", log)
    await handlers.handle_intent(LOG_STUDENT_LOAN, {"amount": 59}, message_for("I haven't paid my student loan $59"))
    log.assert_not_called()


@pytest.mark.parametrize("actual,expected", [("", "No student-loan payment recorded"), ("59", "$59.00")])
@pytest.mark.asyncio
async def test_status_command_reports_recorded_amount_without_writing(actual, expected):
    repo = repo_for(rows=[["", "Student Loan", actual]])
    message = message_for("Did I pay my student loan?")
    with repo.patched():
        await handlers.handle_intent(QUERY_STUDENT_LOAN, {}, message)
    assert expected in message.channel.send.call_args.args[0]
    assert not repo.income.spreadsheet.value_calls
    assert not repo.income.spreadsheet.batch_calls


@pytest.mark.asyncio
async def test_hannah_autopay_only_profile_gets_no_separate_payment():
    repo = repo_for(schedules=[SCHEDULE[:9]])
    message = message_for("Log student loan $59", actor=HANNAH)
    with repo.patched():
        await handlers.handle_intent(LOG_STUDENT_LOAN, {"amount": 59}, message)
    assert "subscription autopay" in message.channel.send.call_args.args[0]
    assert not repo.income.spreadsheet.value_calls
    assert not repo.income.spreadsheet.batch_calls


@pytest.mark.asyncio
async def test_agent_bill_status_reads_authenticated_config_without_mutation(monkeypatch):
    from bookiebot.agent import tools
    from bookiebot.agent.context import ConversationContext
    repo = repo_for(rows=[["", "Student Loan", "59"]])
    for name in ("check_rent_paid", "check_pge_paid", "check_recology_paid", "check_water_paid"):
        monkeypatch.setattr(tools.su, name, AsyncMock(return_value=(False, 0)))
    context = ConversationContext(actor_key=BRIAN, discord_user_id=BRIAN, display_name="Brian",
                                  channel_id="1", guild_id="2", thread_id="test")
    with repo.patched():
        result = await tools.load_bill_status(context)
    assert result["owner"] == "Brian" and result["bills"]["student_loan"]["amount"] == 59
    assert not repo.income.spreadsheet.value_calls and not repo.income.spreadsheet.batch_calls


@pytest.mark.asyncio
async def test_standard_retry_stays_before_write_and_preserves_scope(monkeypatch):
    repo = repo_for()
    rows = repo.income.get_all_values()
    read = MagicMock(side_effect=[spreadsheet_read_quota_error(), rows])
    monkeypatch.setattr(repo.income, "get_all_values", read)
    monkeypatch.setattr(handlers.asyncio, "sleep", AsyncMock())
    record = MagicMock(return_value="action")
    monkeypatch.setattr(loans, "record_undo_action", record)
    with repo.patched(), sheet_user_context(BRIAN):
        assert await handlers._log_payment_with_retry(loans.log_standalone_student_loan, 59) == (True, "action")
    assert read.call_count == 2
    assert record.call_count == 1


@pytest.mark.parametrize("phase", ["write", "verify"])
@pytest.mark.asyncio
async def test_after_write_quota_failure_does_not_retry(monkeypatch, phase):
    repo = repo_for()
    book = repo.income.spreadsheet
    update = MagicMock(side_effect=spreadsheet_read_quota_error() if phase == "write" else None)
    read = MagicMock(side_effect=[{"values": [["Student Loan", ""]]}, spreadsheet_read_quota_error()])
    monkeypatch.setattr(book, "values_batch_update", update)
    monkeypatch.setattr(book, "values_get", read)
    monkeypatch.setattr(loans, "record_undo_action", MagicMock(return_value="action"))
    with repo.patched(), sheet_user_context(BRIAN), pytest.raises(SheetRoutingError, match="before retrying"):
        await handlers._log_payment_with_retry(loans.log_standalone_student_loan, 59)
    assert update.call_count == 1


def test_readback_row_change_stops_confirmation(monkeypatch):
    repo = repo_for()
    book = repo.income.spreadsheet
    monkeypatch.setattr(book, "values_get", MagicMock(side_effect=[{"values": [["Student Loan", ""]]}, {"values": [["Water", "59"]]}]))
    monkeypatch.setattr(loans, "record_undo_action", MagicMock(return_value="action"))
    with repo.patched(), sheet_user_context(BRIAN), pytest.raises(SheetRoutingError, match="row changed"):
        loans.log_standalone_student_loan(59)


def test_insertion_before_anchor_creation_fails_without_payment_write():
    repo = repo_for(rows=[["", "Student Loan", ""], ["", "Water", "17"]])
    book = repo.income.spreadsheet
    book.after_scan = lambda sheet: sheet.insert(0)
    with repo.patched(), sheet_user_context(BRIAN), pytest.raises(SheetRoutingError, match="row changed"):
        loans.log_standalone_student_loan(59)
    assert not book.value_calls
    assert repo.income.get_all_values()[1:3] == [["", "Student Loan", ""] + [""] * 37, ["", "Water", "17"] + [""] * 37]


def test_insertion_after_anchor_read_writes_only_shifted_loan(monkeypatch):
    repo = repo_for(rows=[["", "Student Loan", "12"], ["", "Water", "17"]])
    book = repo.income.spreadsheet
    book.after_read = lambda sheet, name: sheet.insert(0)
    record = MagicMock(return_value="action")
    monkeypatch.setattr(loans, "record_undo_action", record)
    with repo.patched(), sheet_user_context(BRIAN):
        assert loans.log_standalone_student_loan(59)
    rows = repo.income.get_all_values()
    assert rows[0][2] == "" and rows[1][1:3] == ["Student Loan", 59.0] and rows[2][1:3] == ["Water", "17"]
    assert record.call_args.args[1].row == 2


def test_existing_anchor_tracks_later_insertions(monkeypatch):
    repo = repo_for()
    monkeypatch.setattr(loans, "record_undo_action", MagicMock(return_value="action"))
    with repo.patched(), sheet_user_context(BRIAN):
        assert loans.log_standalone_student_loan(59)
        repo.income.insert(0)
        assert loans.log_standalone_student_loan(60)
    assert len(repo.income.spreadsheet.names) == 2
    assert repo.income.get_all_values()[1][1:3] == ["Student Loan", 60.0]


@pytest.mark.parametrize("actor", [BRIAN, HANNAH])
@pytest.mark.parametrize("name", ["Student Loan", "Student Loan Payment", "STUDENT-LOAN PAYMENT"])
def test_active_subscription_blocks_standalone_status_and_payment(actor, name):
    repo = repo_for()
    repo.subscriptions._rows = [
        ["cadence", "name", "amount", "pull_day", "active"],
        ["monthly", name, "59", "12", "yes"],
    ]
    with repo.patched(), sheet_user_context(actor):
        with pytest.raises(SheetRoutingError, match="already tracked as subscription autopay"):
            loans.student_loan_status()
        with pytest.raises(SheetRoutingError, match="already tracked as subscription autopay"):
            loans.log_standalone_student_loan(59)
    assert not repo.income.spreadsheet.value_calls and not repo.income.spreadsheet.batch_calls
    assert repo.subscriptions.update_calls == repo.bill_schedule.update_calls == 0


@pytest.mark.parametrize("name,active", [("Student Loan", "no"), ("Student Loan Extra", "yes")])
def test_inactive_or_distinct_subscription_does_not_block_configured_loan(name, active):
    repo = repo_for()
    repo.subscriptions._rows = [
        ["cadence", "name", "amount", "pull_day", "active"],
        ["monthly", name, "59", "12", active],
    ]
    with repo.patched(), sheet_user_context(BRIAN):
        assert loans.student_loan_status()["configured"]


@pytest.mark.parametrize("rows", [
    [["Needs"], ["Recurring", "Name", "Amount"], ["", "Student Loan Payment", "59"]],
    [["cadence", "name", "amount", "pull_day", "active"], ["monthly", "Student Loan", "59", "", "yes"]],
])
def test_invalid_matching_subscription_date_fails_closed_without_payment(rows):
    repo = repo_for()
    repo.subscriptions._rows = rows
    with repo.patched(), sheet_user_context(HANNAH), pytest.raises(SheetRoutingError, match="subscription autopay"):
        loans.log_standalone_student_loan(59)
    assert not repo.income.spreadsheet.value_calls and not repo.income.spreadsheet.batch_calls


def test_unavailable_subscriptions_fail_closed(monkeypatch):
    repo = repo_for()
    monkeypatch.setattr(repo.subscriptions, "get_all_values", MagicMock(side_effect=RuntimeError("offline")))
    with repo.patched(), sheet_user_context(BRIAN), pytest.raises(SheetRoutingError, match="couldn't verify"):
        loans.log_standalone_student_loan(59)
    assert not repo.income.spreadsheet.value_calls and not repo.income.spreadsheet.batch_calls
