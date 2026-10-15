from pathlib import Path
import subprocess

import pytest


def test_savings_menus_can_overflow_above_investments():
    frontend = Path(__file__).resolve().parents[2] / "web/expense-report/src"
    savings = (frontend / "savings-goals.css").read_text()
    styles = (frontend / "styles.css").read_text()
    savings_section = savings.split(".bb-goals-section.bb-card {", 1)[1].split("}", 1)[0]
    investments_section = styles.split(".bb-investments-section.bb-card {", 1)[1].split("}", 1)[0]

    # A menu's own z-index cannot escape its section's isolated stacking context.
    # Savings must paint above the later Investments card as well as allow overflow.
    assert "overflow: visible;" in savings_section
    assert "clip-path:" not in savings_section
    assert "z-index: 1;" in savings_section
    assert "isolation: isolate;" in investments_section


def test_savings_goal_inputs_progress_and_initial_state():
    root = Path(__file__).resolve().parents[2]
    if not (root / "web/expense-report/node_modules/typescript").exists():
        pytest.skip("Install frontend dependencies to run savings goal UI checks")
    subprocess.run(["node", "unit_tests/reports/savings_goals_ui_test.cjs"],
                   cwd=root, check=True, capture_output=True, text=True)
