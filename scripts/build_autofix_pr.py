"""Build autofix PR metadata from data files, never shell-expanded incident text."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
from typing import Any


def _code_block(text: str, language: str = "") -> str:
    fence = "`" * max(3, max((len(run) for run in re.findall(r"`+", text)), default=0) + 1)
    return f"{fence}{language}\n{text}\n{fence}"


def build_pr_metadata(event: dict[str, Any], codex_output: str | None) -> tuple[str, str]:
    client_payload = event.get("client_payload")
    incident = client_payload.get("incident", {}) if isinstance(client_payload, dict) else {}
    incident_summary = str(incident.get("summary") or "n/a") if isinstance(incident, dict) else "n/a"
    output_lines = (codex_output or "").splitlines()
    title = next((line[len("PR Title:"):].strip() for line in output_lines if line.startswith("PR Title:") and line[len("PR Title:"):].strip()), "")
    title = title or next((line.strip() for line in output_lines if line.strip()), "")
    title = title or (incident_summary if incident_summary != "n/a" else "Codex autofix updates")
    # GitHub's output file is a line-based protocol. Payload newlines/control
    # characters must never create another output key or escape the title field.
    title = " ".join("".join(char if char.isprintable() else " " for char in title).split())[:120]
    title = title or "Codex autofix updates"
    summary_lines = output_lines[:]
    while summary_lines and not summary_lines[0].strip():
        summary_lines.pop(0)
    if summary_lines and summary_lines[0].startswith("PR Title:"):
        summary_lines.pop(0)
    summary = "\n".join(summary_lines).strip() or "No Codex output captured."
    incident_json = json.dumps(incident, ensure_ascii=False, indent=2)
    body = (
        "Automated changes from Codex.\n\n"
        f"Summary (from incident): {incident_summary}\n\n"
        "AI-generated PR summary (from Codex):\n"
        f"{_code_block(summary)}\n\n"
        "Incident payload (JSON):\n"
        f"{_code_block(incident_json, 'json')}\n"
    )
    return title, body


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--event-path", default=os.getenv("GITHUB_EVENT_PATH"), required=not os.getenv("GITHUB_EVENT_PATH"))
    parser.add_argument("--codex-output", default="codex-output.md")
    parser.add_argument("--body-path", default="pr-body.md")
    parser.add_argument("--github-output", default=os.getenv("GITHUB_OUTPUT"), required=not os.getenv("GITHUB_OUTPUT"))
    args = parser.parse_args()
    event = json.loads(Path(args.event_path).read_text(encoding="utf-8"))
    if not isinstance(event, dict):
        raise ValueError("GitHub event must be a JSON object")
    output_path = Path(args.codex_output)
    codex_output = output_path.read_text(encoding="utf-8") if output_path.is_file() else None
    title, body = build_pr_metadata(event, codex_output)
    Path(args.body_path).write_text(body, encoding="utf-8")
    with Path(args.github_output).open("a", encoding="utf-8") as output_file:
        output_file.write(f"pr_title={title}\n")


if __name__ == "__main__":
    main()
