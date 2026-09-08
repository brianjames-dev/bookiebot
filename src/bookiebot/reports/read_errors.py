"""Private report-read diagnostics without provider payloads or credentials."""
from __future__ import annotations

import logging
from typing import Literal

from aiohttp import web
from requests import Timeout as RequestsTimeout

from bookiebot.sheets.routing import SpreadsheetQuotaError

logger = logging.getLogger(__name__)


def _upstream_status(error: BaseException) -> int | None:
    seen: set[int] = set()
    current: BaseException | None = error
    status: int | None = None
    while current is not None and id(current) not in seen:
        seen.add(id(current))
        if isinstance(current, SpreadsheetQuotaError):
            return 429
        for candidate in (getattr(getattr(current, "response", None), "status_code", None),
                          getattr(current, "status_code", None), getattr(current, "code", None)):
            if type(candidate) is int and 100 <= candidate <= 599:
                if candidate == 429:
                    return candidate
                if status is None:
                    status = candidate
        current = current.__cause__ or current.__context__
    return status


def is_report_quota_error(error: BaseException) -> bool:
    return _upstream_status(error) == 429


def is_report_timeout_error(error: BaseException) -> bool:
    """Recognize source deadlines by exception type without inspecting messages."""
    seen: set[int] = set()
    current: BaseException | None = error
    while current is not None and id(current) not in seen:
        seen.add(id(current))
        if isinstance(current, (RequestsTimeout, TimeoutError)):
            return True
        current = current.__cause__ or current.__context__
    return False


def report_read_failure(
    error: BaseException, *, operation: Literal["refresh", "comparison", "catalog"], message: str,
) -> web.Response:
    from bookiebot.reports.phone_app import _json

    status = _upstream_status(error)
    # Provider messages/tracebacks can include workbook IDs or private values.
    # Record only the operation, exception class and numeric upstream status.
    logger.warning("Report read failed operation=%s error=%s upstream_status=%s",
                   operation, type(error).__name__, status if status is not None else "unknown")
    if status == 429:
        response = _json({
            "code": "sheets_rate_limited",
            "error": "Google Sheets is temporarily limiting report reads. Please wait about a minute and try again.",
        }, status=503)
        response.headers["Retry-After"] = "60"
        return response
    if is_report_timeout_error(error):
        response = _json({
            "code": "source_timeout",
            "error": "Google Sheets took too long to respond. Please try again shortly.",
        }, status=503)
        response.headers["Retry-After"] = "15"
        return response
    return _json({"code": "report_unavailable", "error": message}, status=503)
