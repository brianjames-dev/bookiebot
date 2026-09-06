from types import SimpleNamespace

import pytest

from bookiebot.reports.worksheet_reads import monthly_worksheet_rows, worksheet_rows
from unit_tests.support.sheets_repo_stub import InMemoryWorksheet


@pytest.mark.parametrize("batch", [False, True])
def test_month_reader_preserves_financial_values_across_transport_adapters(batch):
    source_rows = {
        "January": [["Main Income Source", "xAI"], ["Expected Income Amount", "$3,775.00"]],
        "March": [["3/31/2026", "Paycheck", "$3,100.00"]],
        "April": [[]],
        "December": [["not requested"]],
    }

    def worksheet(title):
        if title not in source_rows:
            raise LookupError(title)
        return InMemoryWorksheet(source_rows[title], title=title)

    spreadsheet = SimpleNamespace(worksheet=worksheet)
    if batch:
        spreadsheet.worksheets = lambda: [worksheet(title) for title in source_rows]
        spreadsheet.values_batch_get = lambda ranges, **kwargs: {
            "valueRanges": [{"values": source_rows[value.strip("'")]} for value in ranges]
        }
    result = monthly_worksheet_rows(spreadsheet, iter([1, 2, 3, 4]))
    assert result == [(1, source_rows["January"]), (3, source_rows["March"]), (4, [[]])]
    source_rows["January"][1][1] = "$4,000.00"
    assert result[0][1][1][1] == "$3,775.00"
    assert monthly_worksheet_rows(spreadsheet, [1])[0][1][1][1] == "$4,000.00"


def test_missing_requested_months_do_not_issue_an_empty_values_request():
    def unexpected_batch(*args, **kwargs):
        pytest.fail("No available requested months should produce no values request")

    spreadsheet = SimpleNamespace(
        worksheets=lambda: [SimpleNamespace(title="Template")], values_batch_get=unexpected_batch,
    )
    assert monthly_worksheet_rows(spreadsheet, [1, 2]) == []


def test_required_sheet_read_failure_is_not_reported_as_empty_financial_data():
    def unavailable():
        raise RuntimeError("temporary worksheet read failure")

    with pytest.raises(RuntimeError, match="worksheet read failure"):
        worksheet_rows(SimpleNamespace(get_all_values=unavailable))
    assert worksheet_rows(None) == []
