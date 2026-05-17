from __future__ import annotations

from typing import Any

import aiohttp

from bookiebot.banking.config import BankingConfig


class PlaidApiError(RuntimeError):
    pass


class PlaidClient:
    def __init__(self, config: BankingConfig):
        self.config = config

    async def create_sandbox_public_token(
        self,
        *,
        institution_id: str = "ins_109508",
        initial_products: list[str] | None = None,
    ) -> str:
        payload: dict[str, Any] = {
            "institution_id": institution_id,
            "initial_products": initial_products or ["transactions"],
        }
        data = await self._post("/sandbox/public_token/create", payload)
        return str(data["public_token"])

    async def exchange_public_token(self, public_token: str) -> tuple[str, str]:
        data = await self._post("/item/public_token/exchange", {"public_token": public_token})
        return str(data["access_token"]), str(data["item_id"])

    async def get_accounts(self, access_token: str) -> list[dict[str, Any]]:
        data = await self._post("/accounts/get", {"access_token": access_token})
        return list(data.get("accounts") or [])

    async def sync_transactions(
        self,
        access_token: str,
        *,
        cursor: str | None = None,
        count: int = 500,
    ) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "access_token": access_token,
            "count": count,
        }
        if cursor:
            payload["cursor"] = cursor
        return await self._post("/transactions/sync", payload)

    async def _post(self, path: str, payload: dict[str, Any]) -> dict[str, Any]:
        if not self.config.configured:
            raise PlaidApiError("Plaid banking config is incomplete")

        body = {
            "client_id": self.config.plaid_client_id,
            "secret": self.config.plaid_secret,
            **payload,
        }
        url = f"{self.config.plaid_base_url}{path}"
        async with aiohttp.ClientSession() as session:
            async with session.post(url, json=body, timeout=aiohttp.ClientTimeout(total=30)) as response:
                data = await response.json(content_type=None)
                if response.status >= 400:
                    error_code = data.get("error_code") if isinstance(data, dict) else None
                    error_message = data.get("error_message") if isinstance(data, dict) else None
                    raise PlaidApiError(
                        f"Plaid request failed for {path}: HTTP {response.status}"
                        f"{f' {error_code}' if error_code else ''}"
                        f"{f': {error_message}' if error_message else ''}"
                    )
                if not isinstance(data, dict):
                    raise PlaidApiError(f"Unexpected Plaid response for {path}")
                return data

