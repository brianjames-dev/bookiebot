from pathlib import Path
import subprocess


SCRIPT_PATH = Path("scripts/google-apps-script/budget-system-automation.gs")


def test_income_settings_migration_and_rollover_runtime():
    subprocess.run(["node", "unit_tests/scripts/income_settings_test.cjs"], check=True, capture_output=True, text=True)


def test_personal_budget_income_date_stamping_is_wired_into_setup():
    source = SCRIPT_PATH.read_text(encoding="utf-8")

    assert "function handlePersonalBudgetEdit(e)" in source
    assert 'ScriptApp.newTrigger("handlePersonalBudgetEdit")' in source
    assert "installCurrentYearBudgetEditTriggers();" in source
    assert "incomeLayout.amountColumn" in source
    assert "incomeLayout.dateColumn" in source


def test_personal_budget_income_date_stamping_uses_header_layout_not_fixed_cells():
    source = SCRIPT_PATH.read_text(encoding="utf-8")

    assert "function findPersonalBudgetIncomeLayout(sheet)" in source
    assert 'normalized === "date"' in source
    assert 'normalized === "source" || normalized === "employer"' in source
    assert 'normalized === "amount"' in source


def test_personal_budget_income_edit_does_not_append_placeholder_row():
    source = SCRIPT_PATH.read_text(encoding="utf-8")

    assert "function ensureNextPersonalBudgetIncomePlaceholder(" not in source
    assert "sheet.insertRowAfter(completedRow);" not in source
    assert "placeholderRange.clearContent();" not in source
    assert "repairPersonalBudgetIncomeSummaryFormula(editedSheet, incomeLayout);" in source
    assert "function repairPersonalBudgetIncomeSummaryFormula(" in source
    assert "if (!editTouchesAmount && !editTouchesSource)" in source
