"""Daily in-app invoice check-ins. Preferences/claims contain no money ledger."""
from __future__ import annotations

from datetime import datetime, timedelta
from functools import lru_cache
import hashlib
import re
from typing import Any

from bookiebot.reports.app_access import AppAccessStore, PostgresAppAccessStore, build_app_access_store
from bookiebot.sheets.recurring import BillValidation
from bookiebot.sheets.recurring_storage import read_workbook
from bookiebot.sheets.routing import now_pacific, PACIFIC_TZ

DEFAULT_LEAD_DAYS = 7
LEASE_SECONDS = 120


class BillCheckinStore:
    def __init__(self, access: AppAccessStore):
        self.access = access
        with access.connect(write=True) as db:
            if isinstance(access, PostgresAppAccessStore):
                db.execute("SELECT pg_advisory_xact_lock(84392521)")
            db.execute("""CREATE TABLE IF NOT EXISTS app_bill_checkin_preferences (
                owner_key TEXT NOT NULL, bill_id TEXT NOT NULL, lead_days INTEGER,
                PRIMARY KEY(owner_key, bill_id))""")
            db.execute("""CREATE TABLE IF NOT EXISTS app_bill_checkin_days (
                owner_key TEXT NOT NULL, local_day TEXT NOT NULL, token TEXT NOT NULL,
                state TEXT NOT NULL, expires_at BIGINT NOT NULL,
                PRIMARY KEY(owner_key, local_day))""")

    def preferences(self, owner: str) -> dict[str, int | None]:
        with self.access.connect() as db:
            rows = db.execute("SELECT bill_id, lead_days FROM app_bill_checkin_preferences WHERE owner_key=?", (owner,)).fetchall()
        return {r['bill_id']: r['lead_days'] for r in rows}

    def preference(self, owner: str, bill_id: str, lead: Any) -> None:
        if lead is not None and (type(lead) is not int or not 1 <= lead <= 30):
            raise BillValidation("Choose a check-in between 1 and 30 days before payment, or Off.")
        with self.access.connect(write=True) as db:
            db.execute("""INSERT INTO app_bill_checkin_preferences(owner_key,bill_id,lead_days) VALUES(?,?,?)
                ON CONFLICT(owner_key,bill_id) DO UPDATE SET lead_days=excluded.lead_days""", (owner, bill_id, lead))

    def day(self, owner: str, token: str, action: str, current: datetime) -> dict[str, Any]:
        if not isinstance(token, str) or not re.fullmatch(r"[a-zA-Z0-9-]{16,80}", token):
            raise BillValidation("Reload BookieBot to check upcoming bills.")
        current = current.astimezone(PACIFIC_TZ)
        day, stamp = current.strftime('%Y-%m-%d'), int(current.timestamp())
        with self.access.connect(write=True) as db:
            if isinstance(self.access, PostgresAppAccessStore):
                db.execute("SELECT pg_advisory_xact_lock(84392522, ?)", (int(hashlib.sha256(owner.encode()).hexdigest()[:8], 16) - 2**31,))
            row = db.execute("SELECT * FROM app_bill_checkin_days WHERE owner_key=? AND local_day=?", (owner, day)).fetchone()
            if action == 'release':
                db.execute("DELETE FROM app_bill_checkin_days WHERE owner_key=? AND local_day=? AND token=? AND state='reserved'", (owner, day, token))
                return {'day': day, 'claimed': False}
            if action == 'shown':
                if row and row['token'] == token and (row['state'] == 'shown' or row['expires_at'] > stamp):
                    db.execute("UPDATE app_bill_checkin_days SET state='shown' WHERE owner_key=? AND local_day=? AND token=?", (owner, day, token))
                    return {'day': day, 'shown': True}
                return {'day': day, 'shown': False}
            if action != 'claim':
                raise BillValidation("Choose a bill check-in action.")
            if row and (row['state'] == 'shown' or row['expires_at'] > stamp and row['token'] != token):
                return {'day': day, 'claimed': False}
            db.execute("""INSERT INTO app_bill_checkin_days(owner_key,local_day,token,state,expires_at) VALUES(?,?,?,'reserved',?)
                ON CONFLICT(owner_key,local_day) DO UPDATE SET token=excluded.token,state='reserved',expires_at=excluded.expires_at""",
                (owner, day, token, stamp + LEASE_SECONDS))
            return {'day': day, 'claimed': True}


@lru_cache(maxsize=4)
def _store(access: AppAccessStore) -> BillCheckinStore:
    return BillCheckinStore(access)


def build_store() -> BillCheckinStore:
    return _store(build_app_access_store())


def candidates(actor: str, *, current: datetime | None = None, store: BillCheckinStore | None = None) -> dict[str, Any]:
    current = (current or now_pacific()).astimezone(PACIFIC_TZ)
    snapshot = read_workbook(actor, current.date())
    prefs = (store or build_store()).preferences(snapshot.owner)
    period = snapshot.settings.period
    bills = []
    for plan in snapshot.settings.records():
        if plan.kind != 'variable' or not plan.active or not plan.effective_from <= period < plan.effective_until:
            continue
        info, due = snapshot.charge(plan, period), plan.due_date(period)
        lead = prefs.get(plan.id, DEFAULT_LEAD_DAYS)
        if (lead is None or due is None or not info.get('available') or not info.get('canConfirmAmount')
                or info.get('recorded') or info.get('amountCents') or current.date() < due - timedelta(days=lead)):
            continue
        bills.append({'id': plan.id, 'name': plan.name, 'month': period, 'date': due.isoformat(),
                      'overdue': due < current.date()})
    return {'day': current.strftime('%Y-%m-%d'), 'bills': sorted(bills, key=lambda b: (b['date'], b['name']))}


def preference(actor: str, body: dict[str, Any], *, store: BillCheckinStore | None = None) -> dict[str, Any]:
    if set(body) != {'id', 'leadDays'} or not isinstance(body.get('id'), str):
        raise BillValidation('Choose a bill check-in setting.')
    snapshot = read_workbook(actor, now_pacific().date())
    plan = next((p for p in snapshot.settings.records() if p.id == body['id'] and p.kind == 'variable' and p.active), None)
    if plan is None or snapshot.responsible_owner(plan, snapshot.settings.period) != snapshot.owner:
        raise BillValidation("Only this bill's payer can change its check-in.")
    (store or build_store()).preference(snapshot.owner, plan.id, body['leadDays'])
    return {'id': plan.id, 'leadDays': body['leadDays']}
