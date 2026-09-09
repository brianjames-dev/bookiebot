"""Generate or apply a private, reviewed reimbursement migration plan."""
from __future__ import annotations

import argparse
import json
from pathlib import Path


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--env-file", type=Path)
    parser.add_argument("--corrections", type=Path, help="Private allocation-ID keyed verified corrections JSON")
    parser.add_argument("--plan", type=Path, required=True)
    parser.add_argument("--apply", action="store_true", help="Apply this exact saved plan, then verify sheet projections")
    args = parser.parse_args()
    if args.env_file:
        from dotenv import load_dotenv
        load_dotenv(args.env_file)
    from bookiebot.reimbursements.store import build_reimbursement_store
    from bookiebot.reimbursements.migration import plan_migration, apply_migration
    from bookiebot.sheets.auth import get_gspread_client
    store = build_reimbursement_store()
    if args.apply:
        plan = json.loads(args.plan.read_text())
        complete = apply_migration(store, plan)
        print(json.dumps({"registered": len(plan["allocations"]), "projectionComplete": complete}))
        if not complete:
            raise SystemExit(2)
    else:
        existing = {row["id"] for row in store.snapshot("brian")["allocations"]}
        corrections = json.loads(args.corrections.read_text()) if args.corrections else {}
        plan = plan_migration(get_gspread_client(), corrections=corrections, existing_ids=existing)
        args.plan.write_text(json.dumps(plan, indent=2) + "\n")
        args.plan.chmod(0o600)
        print(json.dumps({"planned": len(plan["allocations"]), "issues": plan["issues"], "path": str(args.plan)}))


if __name__ == "__main__":
    main()
