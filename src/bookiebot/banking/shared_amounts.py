"""Explicit bank amount corrections retain, but never record, repayments."""
from typing import Any

from bookiebot.reimbursements import service as repayments
from bookiebot.reimbursements.store import (
    ReimbursementConflictError, ReimbursementNotFoundError, ReimbursementValidationError,
)


class SharedAmountRejected(ValueError):
    """The current attempt did not save a new financial revision."""


def shared_amount_review(owner: str, logged: Any, gross: int, review_id: int) -> dict[str, Any] | None:
    allocation_id = logged.action.metadata.get("allocation_id")
    if not allocation_id or not repayments.enabled():
        return None
    return repayments.build_reimbursement_store().bank_amount_review(owner, allocation_id, gross, review_id)


def apply_shared_amount(owner: str, logged: Any, gross: int, review_id: int, token: str) -> bool:
    """Save once, then verify the selected projection before confirming a match.

    Exceptions before the durable revision are safe rejections. Projection errors
    propagate after saving and require recovery from the saved review token.
    """
    from bookiebot.reimbursements.projection import sync_pending
    store = repayments.build_reimbursement_store()
    allocation_id = logged.action.metadata["allocation_id"]
    try:
        store.correct_bank_amount(owner, allocation_id, gross, review_id, token)
    except (ReimbursementConflictError, ReimbursementNotFoundError, ReimbursementValidationError) as exc:
        raise SharedAmountRejected(str(exc)) from exc
    if not sync_pending(store, allocation_ids={allocation_id}):
        return False
    value = store.get_allocation(allocation_id)
    return value["version"] == value["projectedVersion"] and value["grossCents"] == gross
