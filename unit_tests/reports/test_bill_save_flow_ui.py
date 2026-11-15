from pathlib import Path
import subprocess
import pytest


def test_bill_single_review_flow_and_immutable_recovery():
    root = Path(__file__).resolve().parents[2]
    if not (root / 'web/expense-report/node_modules/typescript').exists():
        pytest.skip('Install frontend dependencies')
    subprocess.run(['node','unit_tests/reports/bill_save_flow_test.cjs'],cwd=root,check=True,capture_output=True,text=True)
