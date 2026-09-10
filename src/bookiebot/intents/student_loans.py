"""Affirmative grammar for the optional, separately configured loan payment."""
from __future__ import annotations

import re
from typing import Any

LOG_STUDENT_LOAN = "log_standalone_student_loan"
QUERY_STUDENT_LOAN = "query_standalone_student_loan"


def student_loan_intent(content: str) -> tuple[str, dict[str, Any]] | None:
    text = " ".join(content.lower().replace("’", "'").split())
    if not re.search(r"\bstudent[ -]loans?\b", text):
        return None
    loan = r"(?:my |the )?student[ -]loan(?: payment| bill)?"
    # These are questions about the author's own current-month row only.
    if any(re.fullmatch(pattern, text) for pattern in (
        rf"(?:did i pay|have i paid) {loan}[?.!]?",
        rf"(?:is|was) {loan} paid[?.!]?",
        rf"(?:check|show) {loan}(?: paid| status| payment status)?[?.!]?",
        rf"{loan} (?:paid|status)[?.!]?",
    )):
        return QUERY_STUDENT_LOAN, {}
    if re.search(r"\b(?:not|never|don't|didn't|haven't|hasn't|won't|wouldn't|shouldn't|can't|cannot|no)\b", text):
        return "fallback", {}
    amount = r"\$?\s*(?P<amount>(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,2})?)"
    command = r"(?:please )?(?:(?:can|could|would|will) you )?(?:please )?(?:log|record|add) "
    suffix = r"(?: today)?[.!?]?"
    patterns = (
        rf"{command}{loan}(?: paid)? {amount}{suffix}",
        rf"{command}{amount}(?: for)? {loan}{suffix}",
        rf"(?:i (?:have )?|i've )?paid {amount}(?: for)? {loan}{suffix}",
        rf"(?:i (?:have )?|i've )?paid {loan}(?: for)? {amount}{suffix}",
    )
    if not text.endswith("?") or re.match(command, text):
        for pattern in patterns:
            if match := re.fullmatch(pattern, text):
                return LOG_STUDENT_LOAN, {"amount": float(match.group("amount").replace(",", ""))}
    # Existing logged payments retain their ordinary guarded recent-action flow.
    if re.match(r"^(?:please )?(?:update|change|correct|edit|fix|delete|remove|move|split)\b", text) and not re.search(
        r"\b(?:tomorrow|next|plan|should|would|could)\b|\?", text,
    ):
        return None
    return "fallback", {}
