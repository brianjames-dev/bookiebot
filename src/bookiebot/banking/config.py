from __future__ import annotations

from dataclasses import dataclass
import os
from pathlib import Path


PLAID_BASE_URLS = {
    "sandbox": "https://sandbox.plaid.com",
    "production": "https://production.plaid.com",
}


@dataclass(frozen=True)
class BankingConfig:
    plaid_client_id: str
    plaid_secret: str
    plaid_env: str
    token_encryption_key: str
    sqlite_path: Path
    database_url: str | None = None
    public_base_url: str | None = None
    plaid_redirect_uri: str | None = None
    plaid_webhook_url: str | None = None

    @property
    def plaid_base_url(self) -> str:
        return PLAID_BASE_URLS.get(self.plaid_env, PLAID_BASE_URLS["sandbox"])

    @property
    def configured(self) -> bool:
        return bool(self.plaid_client_id and self.plaid_secret and self.token_encryption_key)

    @property
    def credentials_present(self) -> bool:
        return bool(self.plaid_client_id and self.plaid_secret)


def load_banking_config() -> BankingConfig:
    sqlite_path = Path(os.getenv("BANK_SQLITE_PATH", "data/banking.sqlite3")).expanduser()
    plaid_env = os.getenv("PLAID_ENV", "sandbox").strip().lower() or "sandbox"
    if plaid_env not in PLAID_BASE_URLS:
        plaid_env = "sandbox"

    return BankingConfig(
        plaid_client_id=os.getenv("PLAID_CLIENT_ID", "").strip(),
        plaid_secret=os.getenv("PLAID_SECRET", "").strip(),
        plaid_env=plaid_env,
        token_encryption_key=os.getenv("BANK_TOKEN_ENCRYPTION_KEY", "").strip(),
        sqlite_path=sqlite_path,
        database_url=os.getenv("BANK_DATABASE_URL", "").strip() or None,
        public_base_url=os.getenv("PUBLIC_BASE_URL", "").strip() or None,
        plaid_redirect_uri=os.getenv("PLAID_REDIRECT_URI", "").strip() or None,
        plaid_webhook_url=os.getenv("PLAID_WEBHOOK_URL", "").strip() or None,
    )
