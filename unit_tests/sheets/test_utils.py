import pytest
from unittest.mock import MagicMock, patch, AsyncMock
from datetime import datetime

from bookiebot.sheets import utils as su
from unit_tests.support.sheets_repo_stub import SheetsRepoStub


# ---------------------------------------------------------------------------
# Fixtures & helpers
# ---------------------------------------------------------------------------
@pytest.fixture(autouse=True)
def _freeze_today(monkeypatch):
    monkeypatch.setattr(su, "get_local_today", lambda: datetime(2025, 5, 15))
    yield


@pytest.fixture
def persons():
    return ["Hannah", "Brian (BofA)"]


def _food_row(date_str, amount, person):
    row = [""] * 26  # enough columns through Z
    row[su.column_index_from_string("N") - 1] = date_str
    row[su.column_index_from_string("P") - 1] = str(amount)
    row[su.column_index_from_string("R") - 1] = person
    return row


def _shopping_row(date_str, amount, person):
    row = [""] * 26
    row[su.column_index_from_string("V") - 1] = date_str
    row[su.column_index_from_string("X") - 1] = str(amount)
    row[su.column_index_from_string("Z") - 1] = person
    return row


def _needs_row(date_str, item, amount, location, person):
    row = [""] * 34  # enough columns through AH
    row[su.column_index_from_string("AD") - 1] = date_str
    row[su.column_index_from_string("AE") - 1] = item
    row[su.column_index_from_string("AF") - 1] = str(amount)
    row[su.column_index_from_string("AG") - 1] = location
    row[su.column_index_from_string("AH") - 1] = person
    return row


def test_resolve_query_persons_uses_discord_user_id():
    result = su.resolve_query_persons("hannerish#0000", None, "1395120954589315303")
    assert result == ["Hannah"]


def test_resolve_query_persons_disambiguates_shared_shortcut_relay_id():
    result = su.resolve_query_persons(".Deebers#0000", None, "1395120954589315303")
    assert result == ["Brian (BofA)", "Brian (AL)"]


def test_log_payment_updates_and_verifies_income_cell():
    repo = SheetsRepoStub(income_rows=[["", "Rent", ""]])

    with repo.patched():
        assert su.log_payment("rent", 1625) is True

    assert repo.income.acell("C1").value == "1625"


def test_log_payment_returns_false_when_label_missing():
    repo = SheetsRepoStub(income_rows=[["", "Groceries", ""]])

    with repo.patched():
        assert su.log_payment("rent", 1625) is False


@pytest.mark.asyncio
async def test_third_savings_check_and_log_use_the_third_paycheck_row():
    repo = SheetsRepoStub(
        income_rows=[
            ["", "Enter 1st Paycheck Deposit", "IDEAL = $100.00", "MINIMUM = $50.00", "$90.00"],
            ["", "Enter 2nd Paycheck Deposit", "IDEAL = $100.00", "MINIMUM = $50.00", "$80.00"],
            ["", "Enter 3rd Paycheck Deposit", "IDEAL = $100.00", "MINIMUM = $50.00", "$0.00"],
        ]
    )

    with repo.patched():
        before = await su.check_3rd_savings_deposited()
        assert su.log_3rd_savings(75.25) is True
        after = await su.check_3rd_savings_deposited()

    assert before == {
        "deposited": False,
        "actual": 0.0,
        "ideal": 100.0,
        "minimum": 50.0,
    }
    assert after == {
        "deposited": True,
        "actual": 75.25,
        "ideal": 100.0,
        "minimum": 50.0,
    }
    assert repo.income.acell("E3").value == "75.25"


@pytest.fixture
def mock_ws():
    ws = MagicMock()
    ws.get_all_values.return_value = [
        ["Date", "Amount", "Category"],  # header
        ["05/01/2025", "50", "grocery"],
        ["05/02/2025", "100", "shopping"],
        ["05/03/2025", "0", "grocery"],
        ["05/05/2025", "200", "food"],
        ["05/06/2025", "75", "gas"],
        ["05/11/2025", "25", "shopping"]
    ]
    return ws


@pytest.mark.asyncio
@patch("bookiebot.sheets.utils.get_income_worksheet")
async def test_calculate_burn_rate(mock_get_income_worksheet):
    mock_ws = MagicMock()
    mock_get_income_worksheet.return_value = mock_ws

    # Simulate finding the "🔥 Burn rate:" cell
    cell_mock = MagicMock()
    cell_mock.row = 1
    cell_mock.col = 1
    cell_mock.value = "🔥 Burn rate: $2.63/day"
    mock_ws.find.return_value = cell_mock

    # Simulate fetching description 2 cells to the right
    mock_ws.cell.return_value.value = "⚠️ Over by $764 (+$58.79/day)"

    burn_rate, desc = await su.calculate_burn_rate()

    assert burn_rate == "$2.63/day"
    assert desc == "⚠️ Over by $764 (+$58.79/day)"


@pytest.mark.asyncio
@patch("bookiebot.sheets.utils.get_income_worksheet")
async def test_check_rent_paid(mock_get_income_worksheet):
    mock_ws = MagicMock()
    mock_get_income_worksheet.return_value = mock_ws
    mock_ws.find.return_value.row = 1
    mock_ws.find.return_value.col = 1
    mock_ws.cell.return_value.value = '1200'
    paid, amount = await su.check_rent_paid()
    assert paid is True
    assert amount == 1200.0


@pytest.mark.asyncio
@patch("bookiebot.sheets.utils.get_income_worksheet")
async def test_check_pge_paid(mock_get_income_worksheet):
    mock_ws = MagicMock()
    mock_get_income_worksheet.return_value = mock_ws
    mock_ws.find.return_value.row = 2
    mock_ws.find.return_value.col = 2
    mock_ws.cell.return_value.value = "$85"

    paid, amount = await su.check_pge_paid()

    assert paid is True
    assert amount == 85.0


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("func_name", "label"),
    [
        ("check_recology_paid", "Recology"),
        ("check_water_paid", "Water"),
    ],
)
@patch("bookiebot.sheets.utils.get_income_worksheet")
async def test_check_new_utility_paid(mock_get_income_worksheet, func_name, label):
    mock_ws = MagicMock()
    mock_get_income_worksheet.return_value = mock_ws
    mock_ws.find.return_value.row = 2
    mock_ws.find.return_value.col = 2
    mock_ws.cell.return_value.value = "$85"

    paid, amount = await getattr(su, func_name)()

    mock_ws.find.assert_called_once_with(label)
    assert paid is True
    assert amount == 85.0


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("store", "expected_total"),
    [
        ("Starbucks", 35),
        ("Subway", 15),
    ],
)
@patch("bookiebot.sheets.utils.get_expense_worksheet")
async def test_total_spent_at_store(mock_get_expense_worksheet, store, expected_total):
    mock_ws = MagicMock()
    mock_get_expense_worksheet.return_value = mock_ws

    # Mock data simulating rows starting at row 3 (skipping header)
    mock_ws.get_all_values.return_value = [
        ['header1', 'header2', 'header3'],
        ['header4', 'header5', 'header6'],
        # Food section — cols P/Q (indices 15/16)
        [''] * 15 + ['10', 'Starbucks'] + [''] * 8,   # Food, Starbucks, $10
        [''] * 15 + ['5', 'Starbucks'] + [''] * 8,    # Food, Starbucks, $5
        # Shopping section — cols X/Y (indices 23/24)
        [''] * 23 + ['20', 'Starbucks'] + [''] * 1,   # Shopping, Starbucks, $20
        [''] * 23 + ['15', 'Subway'] + [''] * 1       # Shopping, not Starbucks
    ]

    total = await su.total_spent_at_store(store)
    assert total == expected_total


@pytest.mark.asyncio
@patch("bookiebot.sheets.utils.get_expense_worksheet")
async def test_total_spent_on_item(mock_get_expense_worksheet, persons):
    mock_ws = MagicMock()
    mock_get_expense_worksheet.return_value = mock_ws
    rows = [
        ["hdr"] * 26,
        ["hdr"] * 26,
        _food_row("05/05/2025", 5, "Hannah"),
        _food_row("05/06/2025", 7, "Brian (BofA)"),
    ]
    rows[2][su.column_index_from_string("O") - 1] = "Latte"
    rows[3][su.column_index_from_string("O") - 1] = "latte"
    mock_ws.get_all_values.return_value = rows

    total, matches = await su.total_spent_on_item("Latte", persons)
    assert total == 12.0
    assert len(matches) == 2


@pytest.mark.asyncio
@patch("bookiebot.sheets.utils.column_index_from_string")
@patch("bookiebot.sheets.utils.get_expense_worksheet")
async def test_highest_expense_category(mock_get_expense_worksheet, mock_col_idx):
    mock_ws = MagicMock()
    mock_get_expense_worksheet.return_value = mock_ws

    # ensure column indices match what your col_values mock returns
    mock_col_idx.side_effect = lambda col: {
        'B': 2,
        'I': 9,
        'P': 16,
        'X': 24,
        'AF': 32,
    }[col]

    # mock the col_values per column index
    mock_ws.col_values.side_effect = lambda col: {
        2: ['header', 'header', '10', '20'],      # grocery → 30
        9: ['header', 'header', '5'],            # gas → 5
        16: ['header', 'header', '15', '25'],   # food → 40
        24: ['header', 'header', '50'],         # shopping → 50
        32: ['header', 'header', '75'],         # needs → 75
    }[col]

    category, amount = await su.highest_expense_category()

    assert category == 'need_expenses'
    assert amount == 75.0


@pytest.mark.asyncio
@patch("bookiebot.sheets.utils.get_income_worksheet")
async def test_remaining_budget(mock_get_income_worksheet):
    mock_ws = MagicMock()
    mock_get_income_worksheet.return_value = mock_ws
    mock_ws.find.return_value.row = 1
    mock_ws.find.return_value.col = 1
    mock_ws.cell.return_value.value = '1000'
    remaining = await su.remaining_budget()
    assert remaining == 1000.0


@pytest.mark.asyncio
@patch("bookiebot.sheets.utils.get_income_worksheet")
async def test_total_income_valid(mock_get_income_worksheet):
    mock_ws = MagicMock()
    mock_get_income_worksheet.return_value = mock_ws

    # mock finding the Monthly Income cell
    cell_mock = MagicMock()
    cell_mock.row = 1
    cell_mock.col = 1
    mock_ws.find.return_value = cell_mock

    # mock the adjacent cell value
    mock_ws.cell.return_value.value = "  $5,000 "

    result = await su.total_income()
    assert result == 5000.0


@pytest.mark.asyncio
@patch("bookiebot.sheets.utils.get_income_worksheet")
async def test_total_income_invalid_value(mock_get_income_worksheet):
    mock_ws = MagicMock()
    mock_get_income_worksheet.return_value = mock_ws

    cell_mock = MagicMock()
    cell_mock.row = 1
    cell_mock.col = 1
    mock_ws.find.return_value = cell_mock

    mock_ws.cell.return_value.value = "N/A"

    result = await su.total_income()
    assert result == 0.0


@pytest.mark.asyncio
@patch("bookiebot.sheets.utils.get_income_worksheet")
async def test_total_income_missing_cell(mock_get_income_worksheet):
    mock_ws = MagicMock()
    mock_get_income_worksheet.return_value = mock_ws

    # Simulate .find() throwing an exception
    mock_ws.find.side_effect = Exception("Cell not found")

    result = await su.total_income()
    assert result == 0.0


@pytest.mark.asyncio
@patch("bookiebot.sheets.utils.get_subscriptions_worksheet")
@patch("bookiebot.sheets.utils.get_income_worksheet")
@patch("bookiebot.sheets.utils.get_expense_worksheet")
async def test_expense_breakdown_percentages(mock_ws_func, mock_income_ws_func, mock_subs_ws_func, mock_ws):
    mock_ws_func.return_value = mock_ws

    def _cell(r, c):
        # map row/col to values for grocery/gas/food/shopping
        mapping = {
            # Brian (row 4)
            (4, su.column_index_from_string("F")): "25",   # grocery
            (4, su.column_index_from_string("L")): "10",   # gas
            (4, su.column_index_from_string("T")): "15",   # food
            (4, su.column_index_from_string("AB")): "0",   # shopping
            # Hannah (row 5)
            (5, su.column_index_from_string("F")): "50",
            (5, su.column_index_from_string("L")): "0",
            (5, su.column_index_from_string("T")): "25",
            (5, su.column_index_from_string("AB")): "25",
        }
        return type("Cell", (), {"value": mapping.get((r, c), "0")})

    mock_ws.cell.side_effect = _cell

    income_ws = MagicMock()
    income_rows = {
        "rent": (1, 1, "1200"),
        "pg&e": (2, 1, "100"),
        "recology": (3, 1, "30"),
        "water": (4, 1, "40"),
        "student loan payment": (5, 1, "200"),
    }

    def _find_income(label):
        normalized = label.strip().lower()
        if normalized not in income_rows:
            raise ValueError("not found")
        row, col, _amount = income_rows[normalized]
        return type("Cell", (), {"row": row, "col": col, "value": label})

    def _income_cell(row, col):
        for known_row, known_col, amount in income_rows.values():
            if row == known_row and col == known_col + 1:
                return type("Cell", (), {"value": amount})
        return type("Cell", (), {"value": ""})

    income_ws.find.side_effect = _find_income
    income_ws.cell.side_effect = _income_cell
    mock_income_ws_func.return_value = income_ws

    subs_ws = MagicMock()
    subs_ws.get_all_values.return_value = [
        [],
        ["", "SUBSCRIPTIONS"],
        [],
        ["Needs", "", "(Monthly)", "", "Wants", "", "(Monthly)"],
        ["", "", "", "", "", "", ""],
        ["Recurring:", "Name:", "Amount:", "", "Recurring:", "Name:", "Amount:"],
        ["5th", "Netflix", "$15.00", "", "10th", "Spotify", "$10.00"],
    ]
    mock_subs_ws_func.return_value = subs_ws

    result = await su.expense_breakdown_percentages(["Brian (BofA)", "Hannah"])
    cats = result["categories"]
    assert result["grand_total"] == 1745.0
    assert cats["rent"]["amount"] == 1200.0
    assert cats["bills_utilities"]["amount"] == 370.0
    assert cats["bills_utilities"]["label"] == "Bills & Utilities"
    assert cats["subscriptions"]["amount"] == 25.0
    assert cats["grocery"]["amount"] == 75.0
    assert cats["food"]["percentage"] == pytest.approx(2.29, rel=1e-2)


@pytest.mark.asyncio
@patch("bookiebot.sheets.utils.get_expense_worksheet")
async def test_total_for_category(mock_ws_func, mock_ws, persons):
    mock_ws_func.return_value = mock_ws
    mock_ws.get_all_values.return_value = [
        ["hdr"] * 4,
        ["hdr"] * 4,
        ["05/01/2025", "10", "", "Hannah"],
        ["05/02/2025", "5", "", "SomeoneElse"],
        ["05/03/2025", "15", "", "Brian (BofA)"],
    ]
    result = await su.total_for_category("grocery", persons)
    assert result == 25.0


@pytest.mark.asyncio
@patch("bookiebot.sheets.utils.get_expense_worksheet")
async def test_total_for_needs_category_alias(mock_ws_func, mock_ws, persons):
    mock_ws_func.return_value = mock_ws
    mock_ws.get_all_values.return_value = [
        ["hdr"] * 34,
        ["hdr"] * 34,
        _needs_row("05/01/2025", "Copay", 40, "Kaiser", "Hannah"),
        _needs_row("05/02/2025", "Repair", 75, "Midas", "SomeoneElse"),
        _needs_row("05/03/2025", "Registration", 184, "DMV", "Brian (BofA)"),
    ]

    assert await su.total_for_category("needs", persons) == 224.0


@pytest.mark.asyncio
@patch("bookiebot.sheets.utils.get_expense_worksheet")
async def test_average_daily_spend(mock_ws_func, mock_ws, persons):
    mock_ws_func.return_value = mock_ws
    mock_ws.get_all_values.return_value = [
        ["hdr"] * 26,
        ["hdr"] * 26,
        _food_row("05/05/2025", 20, "Hannah"),    # food
        _shopping_row("05/06/2025", 40, "Brian (BofA)"),  # shopping
    ]
    result = await su.average_daily_spend(persons)
    # total 60 over 15 days in month so far -> 4.0/day
    assert result == 4.0


@pytest.mark.asyncio
@patch("bookiebot.sheets.utils.get_expense_worksheet")
async def test_largest_single_expense(mock_ws_func, mock_ws, persons):
    mock_ws_func.return_value = mock_ws
    mock_ws.get_all_values.return_value = [
        ["hdr"] * 34,
        ["hdr"] * 34,
        _food_row("05/12/2025", 30, "Hannah"),
        _shopping_row("05/14/2025", 50, "Brian (BofA)"),
        _needs_row("05/15/2025", "DMV Registration", 184, "DMV", "Hannah"),
    ]
    result = await su.largest_single_expense(persons)
    assert isinstance(result, dict)
    assert result["amount"] == 184.0
    assert result["category"] == "need_expenses"
    assert result["item"] == "DMV Registration"


@pytest.mark.asyncio
@patch("bookiebot.sheets.utils.get_expense_worksheet")
async def test_top_n_expenses_all_categories(mock_ws_func, mock_ws, persons):
    mock_ws_func.return_value = mock_ws
    mock_ws.get_all_values.return_value = [
        ["hdr"] * 34,
        ["hdr"] * 34,
        _food_row("05/12/2025", 30, "Hannah"),            # food amount
        _shopping_row("05/14/2025", 50, "Brian (BofA)"),  # shopping amount
        _needs_row("05/15/2025", "DMV Registration", 184, "DMV", "Hannah"),
    ]

    results = await su.top_n_expenses_all_categories(persons, n=3)
    assert len(results) == 3
    assert results[0]["amount"] == 184.0
    assert results[0]["category"] == "need_expenses"
    assert results[0]["item"] == "DMV Registration"
    assert results[1]["amount"] == 50.0
    assert results[1]["category"] == "shopping"
    assert results[2]["amount"] == 30.0


@pytest.mark.asyncio
@patch("bookiebot.sheets.utils.get_expense_worksheet")
async def test_top_n_expenses(mock_ws_func, mock_ws):
    mock_ws_func.return_value = mock_ws
    top_n = await su.top_n_expenses(3)
    assert isinstance(top_n, list)
    assert all(isinstance(item, tuple) for item in top_n)


@pytest.mark.asyncio
@patch("bookiebot.sheets.utils.get_expense_worksheet")
async def test_spent_this_week(mock_ws_func, mock_ws, persons):
    mock_ws_func.return_value = mock_ws
    mock_ws.get_all_values.return_value = [
        ["hdr"] * 26,
        ["hdr"] * 26,
        _food_row("05/12/2025", 20, "Hannah"),
    ]
    result = await su.spent_this_week(persons)
    assert result == 20.0


@pytest.mark.asyncio
@patch("bookiebot.sheets.utils.get_expense_worksheet")
async def test_projected_spending(mock_ws_func, mock_ws, persons):
    mock_ws_func.return_value = mock_ws
    mock_ws.get_all_values.return_value = [
        ["hdr"] * 26,
        ["hdr"] * 26,
        _food_row("05/01/2025", 30, "Hannah"),
    ]
    result = await su.projected_spending(persons)
    # May 2025: 31 days; spending so far $30 on day 15 -> ~62 projected
    assert result == pytest.approx((30 / 15) * 31, rel=1e-3)


@pytest.mark.asyncio
@patch("bookiebot.sheets.utils.get_expense_worksheet")
async def test_daily_spending_series(mock_ws_func, mock_ws, persons):
    mock_ws_func.return_value = mock_ws
    mock_ws.get_all_values.return_value = [
        ["hdr"] * 26,
        ["hdr"] * 26,
        _food_row("05/05/2025", 12, "Hannah"),
    ]
    series = await su.daily_spending_series(persons)
    assert series["month_label"] == "May 2025"
    assert "05: $12.00" in series["text_summary"]
    assert series["points"][4] == {"day": 5, "amount": 12.0}
    assert series["points"][0] == {"day": 1, "amount": 0.0}
    assert len(series["points"]) == 15


@pytest.mark.asyncio
@patch("bookiebot.sheets.utils.get_expense_worksheet")
async def test_daily_spending_calendar_alias(mock_ws_func, mock_ws, persons):
    mock_ws_func.return_value = mock_ws
    mock_ws.get_all_values.return_value = [
        ["hdr"] * 26,
        ["hdr"] * 26,
        _food_row("05/05/2025", 12, "Hannah"),
    ]
    series = await su.daily_spending_calendar(persons)
    assert series["month_label"] == "May 2025"
    assert "05: $12.00" in series["text_summary"]


@pytest.mark.asyncio
@patch("bookiebot.sheets.utils.get_expense_worksheet")
async def test_best_worst_day_of_week(mock_ws_func, mock_ws, persons):
    mock_ws_func.return_value = mock_ws
    mock_ws.get_all_values.return_value = [
        ["hdr"] * 26,
        ["hdr"] * 26,
        _food_row("05/10/2025", 50, "Hannah"),  # Saturday
        _food_row("05/11/2025", 20, "Hannah"),  # Sunday
        _food_row("05/12/2025", 30, "Hannah"),  # Monday
        _food_row("05/13/2025", 40, "Hannah"),  # Tuesday
        _food_row("05/14/2025", 10, "Hannah"),  # Wednesday
        _food_row("05/15/2025", 35, "Hannah"),  # Thursday
        _food_row("05/16/2025", 45, "Hannah"),  # Friday
    ]
    result = await su.best_worst_day_of_week(persons)
    assert result["best"][0] == "Wednesday"
    assert result["worst"][0] == "Saturday"


@pytest.mark.asyncio
@patch("bookiebot.sheets.utils.get_expense_worksheet")
async def test_longest_no_spend_streak(mock_ws_func, mock_ws, persons):
    mock_ws_func.return_value = mock_ws
    mock_ws.get_all_values.return_value = [
        ["hdr"] * 26,
        ["hdr"] * 26,
        _food_row("05/02/2025", 10, "Hannah"),
        _food_row("05/05/2025", 5, "Hannah"),
    ]
    streak = await su.longest_no_spend_streak(persons)
    assert streak == (10, 6, 15)


@pytest.mark.asyncio
async def test_days_budget_lasts(monkeypatch):
    monkeypatch.setattr(su, "remaining_budget", AsyncMock(return_value=300))
    monkeypatch.setattr(su, "average_daily_spend", AsyncMock(return_value=30))
    result = await su.days_budget_lasts()
    assert result == 10.0


@pytest.mark.asyncio
@patch("bookiebot.sheets.utils.get_expense_worksheet")
async def test_most_frequent_purchases(mock_ws_func, mock_ws, persons):
    mock_ws_func.return_value = mock_ws
    mock_ws.get_all_values.return_value = [
        ["hdr"] * 26,
        ["hdr"] * 26,
        _food_row("05/05/2025", 5, "Hannah"),
        _food_row("05/06/2025", 7, "Brian (BofA)"),
        _food_row("05/07/2025", 3, "Hannah"),
    ]
    for idx, item in [(2, "coffee"), (3, "coffee"), (4, "sandwich")]:
        mock_ws.get_all_values.return_value[idx][su.column_index_from_string("O") - 1] = item

    result = await su.most_frequent_purchases(persons, n=2)
    assert result[0]["item"] == "coffee"
    assert result[0]["count"] == 2


@pytest.mark.asyncio
@patch("bookiebot.sheets.utils.get_expense_worksheet")
async def test_expenses_on_day(mock_ws_func, mock_ws, persons):
    mock_ws_func.return_value = mock_ws
    rows = [
        ["hdr"] * 26,
        ["hdr"] * 26,
        _food_row("05/10/2025", 12, "Hannah"),
    ]
    rows[2][su.column_index_from_string("O") - 1] = "Pizza"
    rows[2][su.column_index_from_string("Q") - 1] = "Dominos"
    mock_ws.get_all_values.return_value = rows

    entries, total = await su.expenses_on_day("05/10/2025", persons)
    assert total == 12.0
    assert entries is not None and entries[0]["item"] == "Pizza"


@pytest.mark.asyncio
@patch("bookiebot.sheets.utils.get_subscriptions_worksheet")
async def test_list_subscriptions(mock_subs_ws):
    rows = [[""] * 6 for _ in range(6)]
    # Needs row (index 6 -> seventh row)
    rows.append(["", "Need A", "15", "", "Want A", "20"])
    rows.append(["", "Need B", "5", "", "", ""])
    mock_subs_ws.return_value.get_all_values.return_value = rows

    needs, needs_total, wants, wants_total = await su.list_subscriptions()
    assert needs == [("Need A", 15.0), ("Need B", 5.0)]
    assert wants == [("Want A", 20.0)]


@pytest.mark.asyncio
@patch("bookiebot.sheets.utils.get_expense_worksheet")
async def test_weekend_vs_weekday(mock_ws_func, mock_ws, persons):
    mock_ws_func.return_value = mock_ws
    mock_ws.get_all_values.return_value = [
        ["hdr"] * 26,
        ["hdr"] * 26,
        _food_row("05/10/2025", 50, "Hannah"),  # Sat
        _food_row("05/12/2025", 30, "Hannah"),  # Mon
    ]
    weekend, weekday = await su.weekend_vs_weekday(persons)
    assert weekend == 50.0
    assert weekday == 30.0


@pytest.mark.asyncio
@patch("bookiebot.sheets.utils.get_expense_worksheet")
async def test_no_spend_days(mock_ws_func, mock_ws, persons):
    mock_ws_func.return_value = mock_ws
    mock_ws.get_all_values.return_value = [
        ["hdr"] * 26,
        ["hdr"] * 26,
        _food_row("05/01/2025", 10, "Hannah"),
        _food_row("05/03/2025", 5, "Hannah"),
    ]
    count, days = await su.no_spend_days(persons)
    assert count == 13  # days 2..15 excluding 1 and 3 up to frozen day 15
    assert 2 in days and 4 in days
