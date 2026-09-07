"""Durable device opt-ins and delivery claims in the existing phone database."""
from __future__ import annotations

import base64
from functools import lru_cache
import hashlib
import json
import re
import time
from typing import Any
from urllib.parse import urlsplit

from bookiebot.reports.app_access import AppAccessStore, AppSession, PostgresAppAccessStore, build_app_access_store

DEFAULT_PREFERENCES = {"weekly": True, "upcoming": False, "showAmounts": False, "hour": 10}
_HOSTS = {"web.push.apple.com", "fcm.googleapis.com", "updates.push.services.mozilla.com"}


def session_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def validate_subscription(value: Any) -> dict[str, Any]:
    """Accept browser-created Web Push endpoints only, never arbitrary URLs."""
    from cryptography.hazmat.primitives.asymmetric import ec

    if not isinstance(value, dict):
        raise ValueError("Invalid phone subscription.")
    endpoint = value.get("endpoint")
    if not isinstance(endpoint, str) or len(endpoint) > 2048 or any(ord(c) < 33 for c in endpoint):
        raise ValueError("Invalid phone subscription.")
    parsed = urlsplit(endpoint)
    if (parsed.scheme != "https" or parsed.hostname not in _HOSTS or parsed.port not in (None, 443)
            or parsed.username or parsed.password or parsed.fragment or not parsed.path.startswith("/")):
        raise ValueError("This phone's push provider is not supported.")
    keys = value.get("keys")
    if not isinstance(keys, dict):
        raise ValueError("Invalid phone subscription keys.")
    for key, length in (("auth", 16), ("p256dh", 65)):
        raw = keys.get(key)
        if not isinstance(raw, str) or not re.fullmatch(r"[A-Za-z0-9_-]{20,100}={0,2}", raw):
            raise ValueError("Invalid phone subscription keys.")
        decoded = base64.urlsafe_b64decode(raw + "=" * (-len(raw) % 4))
        if len(decoded) != length:
            raise ValueError("Invalid phone subscription keys.")
        if key == "p256dh":
            ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), decoded)
    return {"endpoint": endpoint, "keys": {key: keys[key] for key in ("auth", "p256dh")}}


def validate_preferences(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError("Choose your notification preferences.")
    result = {}
    for key in ("weekly", "upcoming", "showAmounts"):
        if type(value.get(key)) is not bool:
            raise ValueError("Choose your notification preferences.")
        result[key] = value[key]
    hour = value.get("hour")
    if type(hour) is not int or not 7 <= hour <= 21:
        raise ValueError("Choose a notification hour between 7 AM and 9 PM Pacific.")
    if not result["weekly"] and not result["upcoming"]:
        raise ValueError("Choose a notification type, or turn notifications off.")
    result["hour"] = hour
    return result


class PhoneNotificationStore:
    def __init__(self, access: AppAccessStore):
        self.access = access
        with access.connect(write=True) as connection:
            if isinstance(access, PostgresAppAccessStore):
                connection.execute("SELECT pg_advisory_xact_lock(84392504)")
            connection.execute("""CREATE TABLE IF NOT EXISTS app_push_keys (
                key_id INTEGER PRIMARY KEY, private_key TEXT NOT NULL, public_key TEXT NOT NULL)""")
            connection.execute("""CREATE TABLE IF NOT EXISTS app_push_subscriptions (
                session_hash TEXT PRIMARY KEY, endpoint_hash TEXT NOT NULL UNIQUE,
                subscription TEXT NOT NULL, preferences TEXT NOT NULL, updated_at BIGINT NOT NULL)""")
            connection.execute("""CREATE TABLE IF NOT EXISTS app_push_deliveries (
                session_hash TEXT NOT NULL, event_key TEXT NOT NULL, status TEXT NOT NULL,
                attempts INTEGER NOT NULL, retry_at BIGINT NOT NULL, updated_at BIGINT NOT NULL,
                PRIMARY KEY(session_hash, event_key))""")

    def keys(self) -> tuple[str, str]:
        from cryptography.hazmat.primitives import serialization
        from cryptography.hazmat.primitives.asymmetric import ec

        with self.access.connect(write=True) as connection:
            row = connection.execute("SELECT private_key, public_key FROM app_push_keys WHERE key_id = 1").fetchone()
            if row is None:
                key = ec.generate_private_key(ec.SECP256R1())
                private = base64.urlsafe_b64encode(key.private_bytes(
                    serialization.Encoding.DER, serialization.PrivateFormat.PKCS8, serialization.NoEncryption())).decode().rstrip("=")
                public = base64.urlsafe_b64encode(key.public_key().public_bytes(
                    serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)).decode().rstrip("=")
                connection.execute("INSERT INTO app_push_keys (key_id, private_key, public_key) VALUES (1, ?, ?) ON CONFLICT(key_id) DO NOTHING", (private, public))
                row = connection.execute("SELECT private_key, public_key FROM app_push_keys WHERE key_id = 1").fetchone()
            return str(row["private_key"]), str(row["public_key"])

    def settings(self, token_hash: str) -> dict[str, Any]:
        with self.access.connect() as connection:
            row = connection.execute("SELECT preferences FROM app_push_subscriptions WHERE session_hash = ?", (token_hash,)).fetchone()
        return {"enabled": row is not None, "preferences": json.loads(row["preferences"]) if row else dict(DEFAULT_PREFERENCES)}

    def subscribe(self, token_hash: str, session: AppSession, subscription: dict, preferences: dict) -> None:
        now = int(time.time())
        endpoint_hash = session_hash(subscription["endpoint"])
        with self.access.connect(write=True) as connection:
            # The cookie may have been revoked while permission/network UI was open.
            valid = connection.execute("SELECT owner_key FROM app_phone_sessions WHERE token_hash = ? AND expires_at > ?", (token_hash, now)).fetchone()
            if valid is None or valid["owner_key"] != session.owner_key:
                raise ValueError("Reconnect this phone before enabling notifications.")
            existing = connection.execute("SELECT session_hash FROM app_push_subscriptions WHERE endpoint_hash = ?", (endpoint_hash,)).fetchone()
            if existing is not None and existing["session_hash"] != token_hash:
                active = connection.execute("SELECT token_hash FROM app_phone_sessions WHERE token_hash = ? AND expires_at > ?", (existing["session_hash"], now)).fetchone()
                if active is not None:
                    raise ValueError("This push subscription is connected to another phone session. Turn it off there first.")
                connection.execute("DELETE FROM app_push_subscriptions WHERE endpoint_hash = ?", (endpoint_hash,))
            connection.execute("""INSERT INTO app_push_subscriptions (session_hash, endpoint_hash, subscription, preferences, updated_at)
                VALUES (?, ?, ?, ?, ?) ON CONFLICT(session_hash) DO UPDATE SET endpoint_hash=excluded.endpoint_hash,
                subscription=excluded.subscription, preferences=excluded.preferences, updated_at=excluded.updated_at""",
                (token_hash, endpoint_hash, json.dumps(subscription), json.dumps(preferences), now))

    def unsubscribe(self, token_hash: str) -> None:
        with self.access.connect(write=True) as connection:
            connection.execute("DELETE FROM app_push_subscriptions WHERE session_hash = ?", (token_hash,))

    def expire_subscription(self, device: dict) -> bool:
        """Revoke only the subscription whose send the provider rejected.

        A phone can replace its subscription or preferences while the old
        request is in flight. That response must not disable its new opt-in.
        """
        with self.access.connect(write=True) as connection:
            result = connection.execute("""DELETE FROM app_push_subscriptions WHERE session_hash = ?
                AND subscription = ? AND preferences = ? AND updated_at = ?""",
                (device["session_hash"], device["subscription"], device["preferences"], device["updated_at"]))
            return result.rowcount == 1

    def active(self, now: int) -> list[dict[str, Any]]:
        with self.access.connect() as connection:
            rows = connection.execute("""SELECT p.*, s.actor_key, s.owner_key, s.expires_at FROM app_push_subscriptions p
                JOIN app_phone_sessions s ON s.token_hash=p.session_hash WHERE s.expires_at > ?""", (now,)).fetchall()
        return [dict(row) for row in rows]

    def is_active(self, token_hash: str, now: int) -> bool:
        with self.access.connect() as connection:
            return connection.execute("""SELECT p.session_hash FROM app_push_subscriptions p JOIN app_phone_sessions s
                ON s.token_hash=p.session_hash WHERE p.session_hash = ? AND s.expires_at > ?""", (token_hash, now)).fetchone() is not None

    def still_matches(self, device: dict, now: int) -> bool:
        with self.access.connect() as connection:
            return connection.execute("""SELECT p.session_hash FROM app_push_subscriptions p JOIN app_phone_sessions s
                ON s.token_hash=p.session_hash WHERE p.session_hash = ? AND s.expires_at > ?
                AND p.subscription = ? AND p.preferences = ?""",
                (device["session_hash"], now, device["subscription"], device["preferences"])).fetchone() is not None

    def can_attempt(self, token_hash: str, event_key: str, now: int) -> bool:
        with self.access.connect() as connection:
            row = connection.execute("SELECT status, attempts, retry_at FROM app_push_deliveries WHERE session_hash=? AND event_key=?", (token_hash, event_key)).fetchone()
        return row is None or (row["status"] in ("pending", "retry", "sending") and row["attempts"] < 3 and row["retry_at"] <= now)

    def claim(self, token_hash: str, event_key: str, now: int) -> bool:
        with self.access.connect(write=True) as connection:
            connection.execute("""INSERT INTO app_push_deliveries (session_hash,event_key,status,attempts,retry_at,updated_at)
                VALUES (?, ?, 'pending', 0, 0, ?) ON CONFLICT(session_hash,event_key) DO NOTHING""", (token_hash, event_key, now))
            result = connection.execute("""UPDATE app_push_deliveries SET status='sending', attempts=attempts+1,
                retry_at=?, updated_at=? WHERE session_hash=? AND event_key=? AND status IN ('pending','retry','sending')
                AND attempts < 3 AND retry_at <= ?""", (now + 300, now, token_hash, event_key, now))
            return result.rowcount == 1

    def complete(self, token_hash: str, event_key: str, now: int, *, accepted: bool, retryable: bool = False) -> None:
        with self.access.connect(write=True) as connection:
            row = connection.execute("SELECT attempts FROM app_push_deliveries WHERE session_hash=? AND event_key=?", (token_hash, event_key)).fetchone()
            if row is None:
                return
            status = "accepted" if accepted else ("retry" if retryable and row["attempts"] < 3 else "failed")
            retry_at = now + 300 * 2 ** max(0, row["attempts"] - 1)
            connection.execute("UPDATE app_push_deliveries SET status=?, retry_at=?, updated_at=? WHERE session_hash=? AND event_key=?", (status, retry_at, now, token_hash, event_key))

    def prune(self, now: int) -> None:
        with self.access.connect(write=True) as connection:
            connection.execute("DELETE FROM app_push_subscriptions WHERE session_hash NOT IN (SELECT token_hash FROM app_phone_sessions WHERE expires_at > ?)", (now,))
            connection.execute("DELETE FROM app_push_deliveries WHERE updated_at < ?", (now - 90 * 86400,))


@lru_cache(maxsize=8)
def _for_access(access: AppAccessStore) -> PhoneNotificationStore:
    return PhoneNotificationStore(access)


def build_phone_notification_store() -> PhoneNotificationStore:
    return _for_access(build_app_access_store())
