from pathlib import Path
import shutil
import subprocess

import pytest


def test_phone_notification_frontend_and_service_worker():
    root = Path(__file__).resolve().parents[2]
    if not shutil.which("node") or not (root / "web/expense-report/node_modules/typescript").exists():
        pytest.skip("Install the report frontend dependencies for UI contracts")
    subprocess.run(["node", str(Path(__file__).with_name("phone_notifications_ui_test.cjs"))], cwd=root, check=True, capture_output=True, text=True)
