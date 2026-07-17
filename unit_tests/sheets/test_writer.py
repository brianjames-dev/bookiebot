import pytest

from bookiebot.sheets import writer
from unit_tests.support.sheets_repo_stub import InMemoryWorksheet


@pytest.mark.asyncio
async def test_expense_sheet_with_retry_recovers_from_transient_access_error(monkeypatch):
    calls = []
    worksheet = object()

    class Repo:
        def expense_sheet(self):
            calls.append("expense_sheet")
            if len(calls) == 1:
                raise RuntimeError("temporary sheets access failure")
            return worksheet

    async def fake_sleep(*_args, **_kwargs):
        return None

    monkeypatch.setattr(writer, "get_sheets_repo", lambda: Repo())
    monkeypatch.setattr(writer.asyncio, "sleep", fake_sleep)

    assert await writer._expense_sheet_with_retry() is worksheet
    assert calls == ["expense_sheet", "expense_sheet"]


def test_log_income_row_replaces_single_placeholder_and_adds_formatted_next_row(monkeypatch):
    worksheet = InMemoryWorksheet(
        [
            ["", "Date:", "Source:", "Amount:"],
            ["", "", "<Enter Source>", "0"],
            ["", "", "Monthly Income:", "=SUM(D2:D2)"],
        ],
        title="Template",
    )
    recorded_actions = []
    insert_calls = []
    original_insert_row = worksheet.insert_row

    def record_insert(values, index, **kwargs):
        insert_calls.append((index, kwargs))
        original_insert_row(values, index, **kwargs)

    def fake_record(_user_key, action):
        recorded_actions.append(action)
        return "income-action-1"

    monkeypatch.setattr(worksheet, "insert_row", record_insert)
    monkeypatch.setattr(writer, "record_undo_action", fake_record)

    row, description, amount, action_id = writer.log_income_row(
        {
            "type": "income",
            "date": "2026-07-16",
            "source": "xAI",
            "label": "paycheck",
            "amount": 2500.0,
        },
        worksheet,
        return_action_id=True,
    )

    assert row == 2
    assert description == "xAI paycheck"
    assert amount == 2500.0
    assert action_id == "income-action-1"
    assert worksheet.get_all_values()[1] == ["", "7/16/2026", "xAI paycheck", "2500.0"]
    assert worksheet.get_all_values()[2] == ["", "", "<Enter Source>", "0"]
    assert worksheet.get_all_values()[3] == ["", "", "Monthly Income:", "=SUM(D2:D3)"]
    assert insert_calls == [(3, {"value_input_option": "USER_ENTERED", "inherit_from_before": True})]

    action = recorded_actions[0]
    assert action.new_values == ["", "7/16/2026", "xAI paycheck", "2500.0"]
    assert action.metadata["income_date_column"] == "2"
    assert action.metadata["income_source_column"] == "3"
    assert action.metadata["income_amount_column"] == "4"

    second_row, _description, _amount = writer.log_income_row(
        {
            "type": "income",
            "date": "2026-07-30",
            "source": "Internet stipend",
            "amount": 150.0,
        },
        worksheet,
    )

    assert second_row == 3
    assert worksheet.get_all_values()[2] == ["", "7/30/2026", "Internet stipend", "150.0"]
    assert worksheet.get_all_values()[3] == ["", "", "<Enter Source>", "0"]
    assert worksheet.get_all_values()[4] == ["", "", "Monthly Income:", "=SUM(D2:D4)"]
    assert insert_calls[-1] == (4, {"value_input_option": "USER_ENTERED", "inherit_from_before": True})


def test_log_income_row_preserves_legacy_undated_layout(monkeypatch):
    worksheet = InMemoryWorksheet(
        [
            ["", "Employer:", "Amount:"],
            ["", "<Enter Employer>", "0"],
            ["", "Monthly Income:", "=SUM(C2:C2)"],
        ],
        title="July",
    )
    recorded_actions = []

    def fake_record(_user_key, action):
        recorded_actions.append(action)
        return "legacy-income-action"

    monkeypatch.setattr(writer, "record_undo_action", fake_record)

    row, _description, _amount = writer.log_income_row(
        {"type": "income", "source": "Gift", "amount": 100.0},
        worksheet,
    )

    assert row == 2
    assert worksheet.get_all_values()[1] == ["", "Gift", "100.0"]
    assert worksheet.get_all_values()[2] == ["", "<Enter Employer>", "0"]
    assert worksheet.get_all_values()[3] == ["", "Monthly Income:", "=SUM(C2:C3)"]
    action = recorded_actions[0]
    assert "income_date_column" not in action.metadata
    assert action.metadata["income_source_column"] == "2"
    assert action.metadata["income_amount_column"] == "3"
