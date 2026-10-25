from pathlib import Path
import subprocess
import pytest


def test_transactions_screen_review_and_recovery():
    root=Path(__file__).resolve().parents[2]
    if not (root/'web/expense-report/node_modules/typescript').exists():
        pytest.skip('Install frontend dependencies to run transaction UI contracts')
    subprocess.run(['node','unit_tests/reports/transactions_screen_test.cjs'],cwd=root,check=True,capture_output=True,text=True)
