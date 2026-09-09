import pytest
from types import SimpleNamespace

from bookiebot.sheets import writer
from unit_tests.support.sheets_repo_stub import InMemoryWorksheet


@pytest.mark.parametrize(
    ("content", "owner", "expected"),
    [
        ("464.72 Hannah's T at Gameday NEED", "brian", ""),
        ("464.72 Brian’s T at Gameday NEED", "hannah", ""),
        ("I paid for Hannah's T, split by income with Hannah", "brian", ""),
        ("I paid for Brian's T, split by income with Brian", "hannah", ""),
        ("Hannah did not pay; I paid for Hannah's coffee", "brian", ""),
        ("Hannah paid $20 for coffee", "brian", "Hannah"),
        ("Coffee $20 paid by Brian", "hannah", "Brian"),
        ("Coffee $20; payer: Hannah", "brian", "Hannah"),
        ("I covered $20 for Hannah", "brian", ""),
        ("I fronted $20 for Brian", "hannah", ""),
        ("I paid for Hannah's T on my AL card", "brian", "Brian (AL)"),
        ("Hannah's T using my Alaska card", "brian", "Brian (AL)"),
        ("I used my Alaska card for Hannah's T", "brian", "Brian (AL)"),
        ("Hannah's T on my BofA card", "brian", "Brian (BofA)"),
        ("Hannah's T $20 Brian (AL)", "brian", "Brian (AL)"),
        ("Hannah's T $20 on Brian (BofA)", "brian", "Brian (BofA)"),
        ("Hannah's T with my Bank of America account", "brian", "Brian (BofA)"),
        ("Hannah's T on Brian's AL card", "hannah", "Brian (AL)"),
        ("Coffee on Hannah's card", "brian", "Hannah"),
    ],
)
def test_expense_payer_requires_payment_evidence_not_an_item_or_partner_name(content, owner, expected):
    assert writer._explicit_expense_payer(content, owner) == expected


@pytest.mark.parametrize(
    ("content", "owner"),
    [
        ("Brian paid $20 and Hannah paid $30 for dinner", "brian"),
        ("I paid $20 on my AL card and on my BofA card", "brian"),
        ("I paid $20 on my AL card", "hannah"),
    ],
)
def test_expense_payer_rejects_conflicting_or_unmapped_payment_evidence(content, owner):
    with pytest.raises(ValueError):
        writer._explicit_expense_payer(content, owner)


class _ExpenseChannel:
    def __init__(self):
        self.sent = []

    async def send(self, content=None, **kwargs):
        self.sent.append((content, kwargs))


def _expense_message(owner, content):
    name, user_id = ("deebers", 676638528590970917) if owner == "brian" else ("hannerish", 830984827904851969)
    return SimpleNamespace(content=content, author=SimpleNamespace(name=name, id=user_id),
                           channel=_ExpenseChannel(), mentions=[])


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("owner", "partner", "item", "expected_person", "payer_share", "partner_share"),
    [
        ("brian", "Hannah", "Hannah's T", "Brian (BofA)", 300.81, 163.91),
        ("hannah", "Brian", "Brian’s T", "Hannah", 163.91, 300.81),
    ],
)
@pytest.mark.parametrize("split_during_log", [False, True])
async def test_need_possessive_item_preserves_authenticated_payer_and_split_direction(
    owner, partner, item, expected_person, payer_share, partner_share, split_during_log,
):
    from bookiebot.intents.handlers import handle_intent
    from bookiebot.sheets.collaboration import list_allocations
    from bookiebot.sheets.routing import sheet_user_context
    from bookiebot.sheets.undo import recent_actions, split_recent_action
    from unit_tests.support.sheets_repo_stub import SheetsRepoStub

    content = f"464.72 {item} at Gameday NEED"
    entities = {"item": "T", "location": "Gameday", "amount": 464.72, "person": partner}
    if split_during_log:
        content += f" split by income with {partner}"
        entities["split_method"] = "income"
    message = _expense_message(owner, content)
    actor = str(message.author.id)
    repo = SheetsRepoStub(expense_rows=[[], []])

    with repo.patched(), sheet_user_context(actor):
        await handle_intent("log_need_expense", entities, message)
        if not split_during_log:
            assert repo.expense.cell(3, 32).value == "$464.72"
            source = recent_actions(actor, 1)[0]
            assert source.action.new_values[1] == item
            assert source.action.new_values[2] == "464.72"
            assert source.action.metadata["person"] == expected_person
            success, _detail = split_recent_action(actor, split_method="income", action_id=source.id)
            assert success
        allocation = list_allocations(actor)[0]
        assert allocation.owner_key == owner
        assert allocation.payer == expected_person
        assert allocation.partner == partner
        assert allocation.item == item
        assert allocation.gross_amount == 464.72
        assert allocation.payer_share == payer_share
        assert allocation.partner_share == partner_share
        assert allocation.received_amount == 0
        assert allocation.outstanding_amount == partner_share

    assert repo.expense.cell(3, 31).value == item
    assert repo.expense.cell(3, 32).value == f"${payer_share:.2f}"
    assert repo.expense.cell(3, 34).value == expected_person


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("owner", "content", "parsed_person", "expected"),
    [
        ("brian", "I paid $20 for Hannah's coffee on my AL card", "Hannah", "Brian (AL)"),
        ("brian", "I paid $20 for Hannah's coffee on my BofA card", "Hannah", "Brian (BofA)"),
        ("brian", "Hannah paid $20 for coffee", "Hannah", "Hannah"),
        ("hannah", "Brian paid $20 for coffee on Brian's AL card", "Brian (AL)", "Brian (AL)"),
        ("brian", "Coffee with Hannah $20", "Hannah", "Brian (BofA)"),
    ],
)
async def test_expense_logging_uses_explicit_card_or_payer_without_trusting_parsed_person(
    owner, content, parsed_person, expected,
):
    from bookiebot.intents.handlers import handle_intent
    from unit_tests.support.sheets_repo_stub import SheetsRepoStub

    repo = SheetsRepoStub(expense_rows=[[], []])
    with repo.patched():
        await handle_intent("log_expense", {
            "item": "coffee", "location": "Cafe", "amount": 20, "category": "food", "person": parsed_person,
        }, _expense_message(owner, content))
    assert repo.expense.cell(3, 18).value == expected


@pytest.mark.asyncio
@pytest.mark.parametrize(("owner", "partner", "person"), [
    ("brian", "Hannah", "Brian (BofA)"), ("hannah", "Brian", "Hannah"),
])
@pytest.mark.parametrize("parsed_method", [True, False])
async def test_fronted_beneficiary_does_not_replace_payer(owner, partner, person, parsed_method):
    from bookiebot.intents.handlers import handle_intent
    from bookiebot.sheets.collaboration import list_allocations
    from bookiebot.sheets.routing import sheet_user_context
    from unit_tests.support.sheets_repo_stub import SheetsRepoStub

    message = _expense_message(owner, f"I covered $20 of coffee for {partner}")
    repo = SheetsRepoStub(expense_rows=[[], []])
    entities = {"item": "coffee", "location": "Cafe", "amount": 20, "category": "food", "person": partner}
    if parsed_method:
        entities["split_method"] = "fronted"
    with repo.patched(), sheet_user_context(str(message.author.id)):
        await handle_intent("log_expense", entities, message)
        allocation = list_allocations(str(message.author.id))[0]
    assert allocation.payer == person
    assert allocation.owner_key == owner
    assert allocation.partner == partner
    assert allocation.payer_share == 0
    assert allocation.partner_share == 20


@pytest.mark.asyncio
async def test_ambiguous_payer_stops_before_expense_write():
    from bookiebot.intents.handlers import handle_intent
    from unit_tests.support.sheets_repo_stub import SheetsRepoStub

    message = _expense_message("brian", "Brian paid $20 and Hannah paid $30 for coffee")
    repo = SheetsRepoStub(expense_rows=[[], []])
    with repo.patched():
        await handle_intent("log_expense", {
            "item": "coffee", "location": "Cafe", "amount": 50, "category": "food", "person": "Hannah",
        }, message)
    assert repo.expense.get_all_values() == [[], []]
    assert any("more than one payer" in content for content, _kwargs in message.channel.sent)


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


def test_log_income_row_consumes_seed_and_inserts_later_rows_just_in_time(monkeypatch):
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
    property_copy_calls = []
    original_insert_row = worksheet.insert_row

    def record_insert(values, index, **kwargs):
        insert_calls.append((index, kwargs))
        original_insert_row(values, index, **kwargs)

    def fake_record(_user_key, action):
        recorded_actions.append(action)
        return "income-action-1"

    monkeypatch.setattr(worksheet, "insert_row", record_insert)
    monkeypatch.setattr(
        writer,
        "_copy_income_row_properties",
        lambda _worksheet, **kwargs: property_copy_calls.append(kwargs),
    )
    monkeypatch.setattr(writer, "record_undo_action", fake_record)

    row, description, amount, action_id = writer.log_income_row(
        {
            "type": "income",
            "date": "2026-07-16",
            "source": "xAI",
            "label": "xAI",
            "amount": 2500.0,
        },
        worksheet,
        return_action_id=True,
    )

    assert row == 2
    assert description == "xAI"
    assert amount == 2500.0
    assert action_id == "income-action-1"
    assert worksheet.get_all_values()[1] == ["", "7/16/2026", "xAI", "2500.0"]
    assert worksheet.get_all_values()[2] == ["", "", "Monthly Income:", "=SUM(D2:D2)"]
    assert insert_calls == []
    assert property_copy_calls == []

    action = recorded_actions[0]
    assert action.kind == "restore_cells"
    assert action.columns == [2, 3, 4]
    assert action.previous_values == ["", "<Enter Source>", "0"]
    assert action.new_values == ["7/16/2026", "xAI", "2500.0"]
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
    assert worksheet.get_all_values()[3] == ["", "", "Monthly Income:", "=SUM(D2:D3)"]
    assert insert_calls[-1] == (3, {"value_input_option": "USER_ENTERED", "inherit_from_before": True})
    assert property_copy_calls[-1] == {
        "source_row": 2,
        "target_row": 3,
        "start_column": 2,
        "end_column": 4,
    }


@pytest.mark.parametrize(
    ("source", "label", "expected"),
    [
        ("xAI", "xAI", "xAI"),
        ("xAI", "xAI paycheck", "xAI paycheck"),
        ("xAI paycheck", "xAI", "xAI paycheck"),
        ("xAI", "paycheck", "xAI paycheck"),
        ("", "bonus", "bonus"),
    ],
)
def test_income_description_deduplicates_overlapping_source_and_label(source, label, expected):
    assert writer._income_description(source, label) == expected


def test_copy_income_row_properties_reapplies_format_validation_notes_and_height():
    class Spreadsheet:
        def __init__(self):
            self.requests = None

        def fetch_sheet_metadata(self, params):
            assert params == {
                "includeGridData": True,
                "ranges": ["'Template'!B5:D5"],
            }
            return {
                "sheets": [
                    {
                        "properties": {"sheetId": 321},
                        "data": [
                            {
                                "rowData": [
                                    {
                                        "values": [
                                            {
                                                "userEnteredFormat": {"numberFormat": {"type": "DATE"}},
                                                "dataValidation": {"condition": {"type": "DATE_IS_VALID"}},
                                                "note": "Enter the income date.",
                                            },
                                            {"userEnteredFormat": {"backgroundColor": {"green": 1}}},
                                            {"userEnteredFormat": {"numberFormat": {"type": "CURRENCY"}}},
                                        ]
                                    }
                                ],
                                "rowMetadata": [{"pixelSize": 24}],
                            }
                        ],
                    }
                ]
            }

        def batch_update(self, body):
            self.requests = body

    class Worksheet:
        title = "Template"
        id = 321
        spreadsheet = Spreadsheet()

    worksheet = Worksheet()
    writer._copy_income_row_properties(
        worksheet,
        source_row=5,
        target_row=6,
        start_column=2,
        end_column=4,
    )

    assert worksheet.spreadsheet.requests == {
        "requests": [
            {
                "updateCells": {
                    "range": {
                        "sheetId": 321,
                        "startRowIndex": 5,
                        "endRowIndex": 6,
                        "startColumnIndex": 1,
                        "endColumnIndex": 4,
                    },
                    "rows": [
                        {
                            "values": [
                                {
                                    "userEnteredFormat": {"numberFormat": {"type": "DATE"}},
                                    "dataValidation": {"condition": {"type": "DATE_IS_VALID"}},
                                    "note": "Enter the income date.",
                                },
                                {"userEnteredFormat": {"backgroundColor": {"green": 1}}},
                                {"userEnteredFormat": {"numberFormat": {"type": "CURRENCY"}}},
                            ]
                        }
                    ],
                    "fields": "userEnteredFormat,dataValidation,note",
                }
            },
            {
                "updateDimensionProperties": {
                    "range": {
                        "sheetId": 321,
                        "dimension": "ROWS",
                        "startIndex": 5,
                        "endIndex": 6,
                    },
                    "properties": {"pixelSize": 24},
                    "fields": "pixelSize",
                }
            },
        ]
    }


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
    assert worksheet.get_all_values()[2] == ["", "Monthly Income:", "=SUM(C2:C2)"]
    action = recorded_actions[0]
    assert action.kind == "restore_cells"
    assert "income_date_column" not in action.metadata
    assert action.metadata["income_source_column"] == "2"
    assert action.metadata["income_amount_column"] == "3"
