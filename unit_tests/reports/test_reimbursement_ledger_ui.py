from pathlib import Path
import subprocess

import pytest


def test_canonical_reimbursement_ui_and_mutation_lifecycle():
    root = Path(__file__).resolve().parents[2]
    if not (root / "web/expense-report/node_modules/typescript").exists():
        pytest.skip("Install frontend dependencies to run reimbursement UI checks")
    subprocess.run(["node", "unit_tests/reports/reimbursement_ledger_ui_test.cjs"],
                   cwd=root, check=True, capture_output=True, text=True)
