from pathlib import Path
import subprocess


def test_bounded_private_display_report():
    subprocess.run(["node", str(Path(__file__).with_name("display_diagnostics_test.cjs"))],
                   cwd=Path(__file__).resolve().parents[2], check=True,
                   capture_output=True, text=True)


def test_display_report_copy_and_manual_fallback():
    subprocess.run(["node", str(Path(__file__).with_name("display_report_test.cjs"))],
                   cwd=Path(__file__).resolve().parents[2], check=True,
                   capture_output=True, text=True)
