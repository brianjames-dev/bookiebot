from pathlib import Path
import subprocess


def test_retained_app_foreground_and_late_viewport_pan():
    subprocess.run(["node", str(Path(__file__).with_name("duo_foreground_test.cjs"))],
                   cwd=Path(__file__).resolve().parents[2], check=True,
                   capture_output=True, text=True)
