"""Shared owner claim boundary for transaction and recurring bill writers."""
from typing import Any
from bookiebot.reports.app_access import PostgresAppAccessStore


def initialize_commands(access: Any):
    with access.connect(write=True) as db:
        if isinstance(access, PostgresAppAccessStore):
            db.execute("SELECT pg_advisory_xact_lock(84392509)")
        # Keep the established Transactions owner lock/table names. Both kinds
        # of command must see an uncertain prior financial write before claiming.
        db.execute("CREATE TABLE IF NOT EXISTS app_transaction_owners (owner_key TEXT PRIMARY KEY)")
        for table in ("app_transaction_commands", "app_bill_commands"):
            db.execute(f"""CREATE TABLE IF NOT EXISTS {table} (
                owner_key TEXT NOT NULL, request_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
                state TEXT NOT NULL, result_json TEXT NOT NULL, command_json TEXT NOT NULL,
                created_at TEXT NOT NULL, PRIMARY KEY(owner_key,request_id))""")
