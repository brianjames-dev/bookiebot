from __future__ import annotations

from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass
from datetime import datetime
import os
from typing import Any, Iterator
from zoneinfo import ZoneInfo


PACIFIC_TZ = ZoneInfo("America/Los_Angeles")

DEFAULT_BRIAN_DISCORD_USER_IDS = ("676638528590970917",)
DEFAULT_HANNAH_DISCORD_USER_IDS = ("830984827904851969",)
APPLE_SHORTCUT_RELAY_USER_ID = "1395120954589315303"
BRIAN_SHORTCUT_ACTOR_KEY = "shortcut:brian"
HANNAH_SHORTCUT_ACTOR_KEY = "shortcut:hannah"

DEFAULT_YEARLY_SHEET_CONFIG = {
    2026: {
        "brian_budget_spreadsheet_id": "1ArI4qapaj-LGg7v5OC47WdfYijjLdu3QPRPgKLbgD3U",
        "hannah_budget_spreadsheet_id": "1lEULEvZ5UzjuhnGPncpvh56xxA8JsfYyns0JS_Okmsg",
        "shared_expenses_spreadsheet_id": "1t2Nm5luEjm-RKiiMyuIFvJBhdI0ubufWkrdjRzBsTgU",
    }
}

_CURRENT_DISCORD_USER_ID: ContextVar[str | None] = ContextVar(
    "bookiebot_current_discord_user_id",
    default=None,
)


class SheetRoutingError(RuntimeError):
    """Base error for sheet routing failures."""


class UnknownDiscordUserError(SheetRoutingError):
    """Raised when a Discord user is not mapped to a budget profile."""


class MissingYearConfigError(SheetRoutingError):
    """Raised when spreadsheet IDs are not configured for the requested year."""


class SpreadsheetAccessError(SheetRoutingError):
    """Raised when a configured spreadsheet cannot be opened."""


class MissingMonthWorksheetError(SheetRoutingError):
    """Raised when a monthly tab is missing from a configured spreadsheet."""


@dataclass(frozen=True)
class DiscordUserConfig:
    name: str
    budget_owner_key: str
    expense_persons: tuple[str, ...]


@dataclass(frozen=True)
class YearlySheetConfig:
    brian_budget_spreadsheet_id: str
    hannah_budget_spreadsheet_id: str
    shared_expenses_spreadsheet_id: str


@dataclass(frozen=True)
class SheetContext:
    year: int
    month_name: str
    user_name: str
    budget_owner_key: str
    personal_budget_spreadsheet_id: str
    shared_expenses_spreadsheet_id: str
    personal_budget_worksheet: Any
    shared_expenses_worksheet: Any


def _csv_env_values(name: str) -> tuple[str, ...]:
    raw = os.getenv(name, "")
    return tuple(value.strip() for value in raw.split(",") if value.strip())


def _configured_user_ids(owner_key: str, defaults: tuple[str, ...]) -> tuple[str, ...]:
    plural = _csv_env_values(f"{owner_key.upper()}_DISCORD_USER_IDS")
    singular = os.getenv(f"{owner_key.upper()}_DISCORD_USER_ID", "").strip()
    env_values = plural + ((singular,) if singular else ())
    values = defaults + env_values
    return tuple(dict.fromkeys(str(value).strip() for value in values if str(value).strip()))


def get_discord_user_config() -> dict[str, DiscordUserConfig]:
    brian_ids = _configured_user_ids("brian", DEFAULT_BRIAN_DISCORD_USER_IDS)
    hannah_ids = _configured_user_ids("hannah", DEFAULT_HANNAH_DISCORD_USER_IDS)

    config: dict[str, DiscordUserConfig] = {}
    for user_id in brian_ids:
        config[user_id] = DiscordUserConfig(
            name="Brian",
            budget_owner_key="brian",
            expense_persons=("Brian (BofA)", "Brian (AL)"),
        )
    for user_id in hannah_ids:
        config[user_id] = DiscordUserConfig(
            name="Hannah",
            budget_owner_key="hannah",
            expense_persons=("Hannah",),
        )
    config[BRIAN_SHORTCUT_ACTOR_KEY] = DiscordUserConfig(
        name="Brian",
        budget_owner_key="brian",
        expense_persons=("Brian (BofA)", "Brian (AL)"),
    )
    config[HANNAH_SHORTCUT_ACTOR_KEY] = DiscordUserConfig(
        name="Hannah",
        budget_owner_key="hannah",
        expense_persons=("Hannah",),
    )
    return config


def normalize_discord_user_id(discord_user_id: Any) -> str | None:
    if discord_user_id is None:
        return None
    user_id = str(discord_user_id).strip()
    return user_id or None


def _normalize_shortcut_sender(discord_user: str | None) -> str:
    user = (discord_user or "").strip().lower()
    if user.endswith("#0000"):
        user = user[:-5]
    return user


def _primary_user_id(owner_key: str, defaults: tuple[str, ...]) -> str:
    return _configured_user_ids(owner_key, defaults)[0]


def resolve_actor_key(discord_user_id: Any, discord_user: str | None = None) -> str | None:
    user_id = normalize_discord_user_id(discord_user_id)
    if user_id != APPLE_SHORTCUT_RELAY_USER_ID:
        return user_id

    sender = _normalize_shortcut_sender(discord_user)
    if sender in {".deebers", "deebers"}:
        return _primary_user_id("brian", DEFAULT_BRIAN_DISCORD_USER_IDS)
    if sender in {"hannerish"}:
        return _primary_user_id("hannah", DEFAULT_HANNAH_DISCORD_USER_IDS)
    return user_id


def get_user_config(discord_user_id: Any, discord_user: str | None = None) -> DiscordUserConfig:
    actor_key = resolve_actor_key(discord_user_id, discord_user)
    if not actor_key:
        raise UnknownDiscordUserError(
            "I don't have your Discord account mapped to a budget profile yet. "
            "Ask Brian to configure your user ID."
        )

    config = get_discord_user_config().get(actor_key)
    if config is None:
        raise UnknownDiscordUserError(
            "I don't have your Discord account mapped to a budget profile yet. "
            "Ask Brian to configure your user ID."
        )
    return config


def now_pacific() -> datetime:
    return datetime.now(PACIFIC_TZ)


def get_current_year(now: datetime | None = None) -> int:
    current = now or now_pacific()
    if current.tzinfo is None:
        current = current.replace(tzinfo=PACIFIC_TZ)
    else:
        current = current.astimezone(PACIFIC_TZ)
    return current.year


def get_current_month_name(now: datetime | None = None) -> str:
    current = now or now_pacific()
    if current.tzinfo is None:
        current = current.replace(tzinfo=PACIFIC_TZ)
    else:
        current = current.astimezone(PACIFIC_TZ)
    return current.strftime("%B")


def _env_sheet_id(prefix: str, year: int, default: str) -> str:
    return os.getenv(f"{prefix}_SPREADSHEET_ID_{year}", default).strip()


def get_year_config(year: int | str) -> YearlySheetConfig:
    year_int = int(year)
    defaults = DEFAULT_YEARLY_SHEET_CONFIG.get(year_int, {})

    config = YearlySheetConfig(
        brian_budget_spreadsheet_id=_env_sheet_id(
            "BRIAN_BUDGET",
            year_int,
            defaults.get("brian_budget_spreadsheet_id", ""),
        ),
        hannah_budget_spreadsheet_id=_env_sheet_id(
            "HANNAH_BUDGET",
            year_int,
            defaults.get("hannah_budget_spreadsheet_id", ""),
        ),
        shared_expenses_spreadsheet_id=_env_sheet_id(
            "SHARED_EXPENSES",
            year_int,
            defaults.get("shared_expenses_spreadsheet_id", ""),
        ),
    )
    missing = [
        name
        for name, value in (
            ("Brian budget", config.brian_budget_spreadsheet_id),
            ("Hannah budget", config.hannah_budget_spreadsheet_id),
            ("shared expenses", config.shared_expenses_spreadsheet_id),
        )
        if not value
    ]
    if missing:
        if defaults:
            message = f"Incomplete spreadsheet configuration for {year_int}: {', '.join(missing)}."
        else:
            message = f"No spreadsheet configuration found for {year_int}."
        raise MissingYearConfigError(message)
    return config


def get_budget_spreadsheet_id_for_user(discord_user_id: Any, year: int | str) -> str:
    user_config = get_user_config(discord_user_id)
    year_config = get_year_config(year)

    if user_config.budget_owner_key == "brian":
        return year_config.brian_budget_spreadsheet_id
    if user_config.budget_owner_key == "hannah":
        return year_config.hannah_budget_spreadsheet_id

    raise UnknownDiscordUserError(
        f"Budget owner '{user_config.budget_owner_key}' is not configured."
    )


def get_shared_expenses_spreadsheet_id(year: int | str) -> str:
    return get_year_config(year).shared_expenses_spreadsheet_id


def get_month_worksheet(gc: Any, spreadsheet_id: str, month_name: str) -> Any:
    try:
        spreadsheet = gc.open_by_key(spreadsheet_id)
    except Exception as exc:
        raise SpreadsheetAccessError(
            f"Could not open spreadsheet '{spreadsheet_id}'. "
            "Check that the Google service account has access to this file."
        ) from exc

    try:
        return spreadsheet.worksheet(month_name)
    except Exception as exc:
        raise MissingMonthWorksheetError(
            f"Worksheet '{month_name}' was not found in spreadsheet '{spreadsheet_id}'."
        ) from exc


def resolve_sheet_context(discord_user_id: Any, gc: Any, now: datetime | None = None) -> SheetContext:
    year = get_current_year(now)
    month_name = get_current_month_name(now)
    user_config = get_user_config(discord_user_id)
    year_config = get_year_config(year)
    personal_budget_spreadsheet_id = get_budget_spreadsheet_id_for_user(discord_user_id, year)
    shared_expenses_spreadsheet_id = year_config.shared_expenses_spreadsheet_id

    return SheetContext(
        year=year,
        month_name=month_name,
        user_name=user_config.name,
        budget_owner_key=user_config.budget_owner_key,
        personal_budget_spreadsheet_id=personal_budget_spreadsheet_id,
        shared_expenses_spreadsheet_id=shared_expenses_spreadsheet_id,
        personal_budget_worksheet=get_month_worksheet(gc, personal_budget_spreadsheet_id, month_name),
        shared_expenses_worksheet=get_month_worksheet(gc, shared_expenses_spreadsheet_id, month_name),
    )


def set_current_discord_user_id(discord_user_id: Any):
    return _CURRENT_DISCORD_USER_ID.set(normalize_discord_user_id(discord_user_id))


def reset_current_discord_user_id(token: Any) -> None:
    _CURRENT_DISCORD_USER_ID.reset(token)


def get_current_discord_user_id() -> str | None:
    return _CURRENT_DISCORD_USER_ID.get()


@contextmanager
def sheet_user_context(discord_user_id: Any) -> Iterator[None]:
    token = set_current_discord_user_id(discord_user_id)
    try:
        yield
    finally:
        reset_current_discord_user_id(token)
