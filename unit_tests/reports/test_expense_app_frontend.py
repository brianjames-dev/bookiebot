from pathlib import Path
import subprocess

import pytest


@pytest.mark.parametrize("script", ["expense_app_session_test.cjs", "header_controls_test.cjs", "report_history_ui_test.cjs"])
def test_expense_app_session_runtime(script):
    root = Path(__file__).resolve().parents[2]
    if not (root / "web/expense-report/node_modules/typescript").exists():
        pytest.skip("Install the expense-report frontend dependencies to run app session checks")
    subprocess.run(
        ["node", f"unit_tests/reports/{script}"],
        cwd=root,
        check=True,
        capture_output=True,
        text=True,
    )
