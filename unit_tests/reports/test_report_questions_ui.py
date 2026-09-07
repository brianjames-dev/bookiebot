from pathlib import Path
import subprocess

import pytest


def test_report_question_ui_and_request_lifecycle():
    root = Path(__file__).resolve().parents[2]
    if not (root / "web/expense-report/node_modules/typescript").exists():
        pytest.skip("Install frontend dependencies for question UI checks")
    subprocess.run(["node", "unit_tests/reports/report_questions_ui_test.cjs"],
                   cwd=root, check=True, capture_output=True, text=True)
