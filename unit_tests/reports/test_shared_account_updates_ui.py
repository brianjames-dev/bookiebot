from pathlib import Path
import shutil
import subprocess

import pytest


def test_shared_state_refresh_preserves_financial_work_and_catches_up_each_screen():
    root = Path(__file__).resolve().parents[2]
    if not shutil.which('node') or not (root / 'web/expense-report/node_modules/typescript').exists():
        pytest.skip('Install frontend dependencies for UI contracts')
    subprocess.run(['node', str(Path(__file__).with_name('shared_account_updates_test.cjs'))],
                   cwd=root, check=True, capture_output=True, text=True)
