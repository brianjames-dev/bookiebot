from pathlib import Path
import shutil
import subprocess

import pytest


def test_shared_loading_status_and_inline_action_markup():
    root = Path(__file__).resolve().parents[2]
    if not shutil.which("node") or not (root / "web/expense-report/node_modules/typescript").exists():
        pytest.skip("Install frontend dependencies for the shared loading UI contract")
    subprocess.run(["node", "unit_tests/reports/report_loading_test.cjs"], cwd=root,
                   check=True, capture_output=True, text=True)
