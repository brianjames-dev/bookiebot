from pathlib import Path
import subprocess
import pytest


def test_bill_current_charge_uses_canonical_review_and_recovery():
    root = Path(__file__).resolve().parents[2]
    if not (root / "web/expense-report/node_modules/typescript").exists():
        pytest.skip("Install the expense-report frontend dependencies")
    subprocess.run(["node", "unit_tests/reports/bill_current_charge_test.cjs"], cwd=root,
                   check=True, capture_output=True, text=True)
