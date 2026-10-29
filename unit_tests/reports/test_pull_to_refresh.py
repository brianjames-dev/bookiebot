from pathlib import Path
import shutil
import subprocess

import pytest


def test_pull_to_refresh_gesture_and_page_lifecycle():
    root = Path(__file__).resolve().parents[2]
    if not shutil.which("node") or not (root / "web/expense-report/node_modules/typescript").exists():
        pytest.skip("Install frontend dependencies for pull-to-refresh UI checks")
    subprocess.run(["node", str(Path(__file__).with_name("pull_to_refresh_test.cjs"))],
                   cwd=root, check=True, capture_output=True, text=True)
