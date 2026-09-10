from pathlib import Path
import subprocess

import pytest


def test_reconciliation_screen_lifecycle():
    root = Path(__file__).resolve().parents[2]
    if not (root / "web/expense-report/node_modules/typescript").exists():
        pytest.skip("Install frontend dependencies to run reconciliation UI checks")
    subprocess.run(["node", "unit_tests/reports/reconciliation_screen_test.cjs"],
                   cwd=root, check=True, capture_output=True, text=True)
