from bookiebot.sheets_repo import get_sheets_repo
from unit_tests.support.sheets_repo_stub import InMemoryWorksheet, SheetsRepoStub


def test_insert_and_update_cell():
    ws = InMemoryWorksheet([["header", "Monthly Income:"], ["", ""]])

    ws.update_cell(2, 2, "123.45")

    cell = ws.cell(2, 2)
    assert cell.value == "123.45"


def test_find_and_col_values():
    ws = InMemoryWorksheet(
        [
            ["date", "store", "amount"],
            ["01/01", "Trader Joe's", "50"],
            ["01/02", "Safeway", "25"],
        ]
    )

    found = ws.find("Trader")
    assert found.row == 2 and found.col == 2

    assert ws.col_values(3) == ["amount", "50", "25"]


def test_patched_context_overrides_repo():
    repo = SheetsRepoStub()
    original = get_sheets_repo()
    with repo.patched():
        assert get_sheets_repo() is repo
    assert get_sheets_repo() is original
