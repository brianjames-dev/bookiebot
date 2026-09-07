from pathlib import Path
import subprocess

import pytest


def test_savings_goal_inputs_progress_and_initial_state():
    root = Path(__file__).resolve().parents[2]
    if not (root / "web/expense-report/node_modules/typescript").exists():
        pytest.skip("Install frontend dependencies to run savings goal UI checks")
    subprocess.run(["node", "unit_tests/reports/savings_goals_ui_test.cjs"],
                   cwd=root, check=True, capture_output=True, text=True)
