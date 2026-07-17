from typing import Optional


# === Friendly display names ===
FRIENDLY_NAMES = {
    "log_expense": "Log Expense",
    "log_income": "Log Income",
    "log_rent_paid": "Log Rent Paid",
    "log_pge_paid": "Log PG&E Paid",
    "log_recology_paid": "Log Recology Paid",
    "log_water_paid": "Log Water Paid",
    "log_1st_savings": "Log 1st Savings Deposit",
    "log_2nd_savings": "Log 2nd Savings Deposit",
    "log_need_expense": "Log NEED Expense",
    "undo_last_transaction": "Undo Last Transaction",
    "delete_recent_action": "Delete Recent Action",
    "query_recent_actions": "Recent Logged Actions",
    "update_recent_action": "Update Recent Action",
    "move_recent_action": "Move Recent Action",
    "query_burn_rate": "Burn Rate",
    "query_rent_paid": "Check Rent Paid",
    "query_pge_paid": "Check PG&E Paid",
    "query_recology_paid": "Check Recology Paid",
    "query_water_paid": "Check Water Paid",
    "query_total_for_store": "Total Spent at Specific Store",
    "query_highest_expense_category": "Highest Expense Category",
    "query_total_income": "Current Total Monthly Income",
    "query_remaining_budget": "Remaining Budget",
    "query_average_daily_spend": "Average Daily Spending Amount",
    "query_expense_breakdown_percentages": "Overall Expense Breakdown",
    "query_total_for_category": "Total for Category",
    "query_largest_single_expense": "Largest Single Expense",
    "query_top_n_expenses": "Largest N Expenses",
    "query_spent_this_week": "Spent This Week",
    "query_projected_spending": "Projected Monthly Spending",
    "query_weekend_vs_weekday": "Weekend vs Weekday",
    "query_no_spend_days": "No Spend Days",
    "query_total_for_item": "Total Spent on Specific Item",
    "query_subscriptions": "Subscriptions",
    "query_daily_spending_calendar": "Daily Spending Calendar",
    "query_best_worst_day_of_week": "Best/Worst Day of Week",
    "query_longest_no_spend_streak": "Longest No-Spend Streak",
    "query_days_budget_lasts": "Days Budget Will Last",
    "query_most_frequent_purchases": "Most Frequent N Purchases",
    "query_expenses_on_day": "Expenses on Specific Day",
    "query_1st_savings": "Check 1st Savings Deposit",
    "query_2nd_savings": "Check 2nd Savings Deposit"
}


def get_friendly_name(intent: str) -> str:
    """Return friendly name for intent"""
    return FRIENDLY_NAMES.get(intent, intent)


INTENT_DETAILS = {
    # Logging Intents
    "log_expense": (
        "Log a general expense to track your spending.",
        ["log expense $25 at grocery store", "spent 40 at restaurant"]
    ),
    "log_income": (
        "Log income you received.",
        ["received paycheck $1500", "logged income $200 from freelance"]
    ),
    "log_rent_paid": (
        "Log that you paid your rent.",
        ["paid rent $1200", "logged rent $1300"]
    ),
    "log_pge_paid": (
        "Log your PG&E utility bill payment.",
        ["paid PG&E $90", "logged PGE bill $100"]
    ),
    "log_recology_paid": (
        "Log your Recology trash bill payment.",
        ["paid Recology $90", "trash bill 100"]
    ),
    "log_water_paid": (
        "Log your water bill payment.",
        ["paid water bill $90", "Santa Rosa Water 100"]
    ),
    "log_1st_savings": (
        "Log a contribution to your first savings account.",
        ["moved $100 to savings 1", "saved 50 in first savings"]
    ),
    "log_2nd_savings": (
        "Log a contribution to your second savings account.",
        ["moved $200 to savings 2", "saved 75 in second savings"]
    ),
    "log_need_expense": (
        "Log a necessary or non-discretionary expense to the shared Needs category.",
        ["logged $80 for medication at CVS (need)", "Need expense $60 for a copay at Kaiser"]
    ),
    "undo_last_transaction": (
        "Undo the most recent transaction logged through BookieBot.",
        ["undo last transaction", "remove my last entry"]
    ),
    "delete_recent_action": (
        "Delete a specific recent logged action after selecting it from recent history.",
        ["remove the most recent Chipotle expense", "delete action 2", "clear id abc123"]
    ),
    "query_recent_actions": (
        "Show recent logged actions that can be changed or undone.",
        ["show my last 10 actions", "I messed up that last one", "can I change that Chipotle expense?"]
    ),
    "update_recent_action": (
        "Update a field on a recent logged action.",
        ["change the last one to $18.25", "update the Chipotle expense amount to 14.50"]
    ),
    "move_recent_action": (
        "Move a recent expense to a different category.",
        ["move the Chipotle expense to food", "that grocery expense should be shopping"]
    ),

    # Query Intents
    "query_burn_rate": (
        "Check your current burn rate (how fast you’re spending money).",
        ["what is my burn rate?", "show current spending rate"]
    ),
    "query_rent_paid": (
        "Check if/when your rent was paid.",
        ["when did I last pay rent?", "have I paid rent this month?"]
    ),
    "query_pge_paid": (
        "Check if/when your PG&E bill was paid.",
        ["when did I last pay PG&E?", "show PGE payments"]
    ),
    "query_recology_paid": (
        "Check if/when your Recology trash bill was paid.",
        ["when did I last pay Recology?", "trash bill paid?"]
    ),
    "query_water_paid": (
        "Check if/when your water bill was paid.",
        ["when did I last pay water?", "Santa Rosa Water paid?"]
    ),
    "query_total_for_store": (
        "Get the total amount spent at a specific store.",
        ["how much did I spend at Target?", "total spent at Amazon"]
    ),
    "query_highest_expense_category": (
        "Find out which expense category has the highest total.",
        ["what’s my highest expense category?", "biggest spending category"]
    ),
    "query_total_income": (
        "Get the total income over a period of time.",
        ["what’s my total income this month?", "how much money came in?"]
    ),
    "query_remaining_budget": (
        "Check how much budget you have left.",
        ["how much budget remains?", "remaining budget for the month"]
    ),
    "query_average_daily_spend": (
        "Get your average daily spending.",
        ["what’s my average daily spend?", "daily spending average"]
    ),
    "query_expense_breakdown_percentages": (
        "Get a percentage breakdown of expenses by category.",
        ["show expenses by percentage", "expense category breakdown"]
    ),
    "query_total_for_category": (
        "Get the total amount spent in a specific category.",
        ["total for groceries?", "how much did I spend on dining?"]
    ),
    "query_largest_single_expense": (
        "Find your largest single expense.",
        ["what’s my biggest single expense?", "largest expense"]
    ),
    "query_top_n_expenses": (
        "Get your top N largest expenses.",
        ["show top 3 expenses", "what are my 5 biggest expenses?"]
    ),
    "query_spent_this_week": (
        "See how much you’ve spent this week.",
        ["how much did I spend this week?", "weekly spending"]
    ),
    "query_projected_spending": (
        "Get projected spending based on current trends.",
        ["what is my projected spending?", "forecast my expenses"]
    ),
    "query_weekend_vs_weekday": (
        "Compare weekend and weekday spending.",
        ["weekend vs weekday spending", "do I spend more on weekends?"]
    ),
    "query_no_spend_days": (
        "Find out how many days you spent nothing.",
        ["how many no-spend days?", "days with no spending"]
    ),
    "query_total_for_item": (
        "Check total spent on a specific item.",
        ["total spent on coffee?", "how much have I spent on shoes?"]
    ),
    "query_subscriptions": (
        "List recurring subscriptions and their costs.",
        ["what are my subscriptions?", "list all recurring expenses"]
    ),
    "query_daily_spending_calendar": (
        "View spending on a daily calendar.",
        ["show daily spending calendar", "daily expenses calendar"]
    ),
    "query_best_worst_day_of_week": (
        "Find your best (least spending) and worst (most spending) day of the week.",
        ["best and worst spending day", "which day do I spend most?"]
    ),
    "query_longest_no_spend_streak": (
        "Find your longest streak of no-spend days.",
        ["longest no-spend streak?", "longest period with no expenses"]
    ),
    "query_days_budget_lasts": (
        "Estimate how many days your remaining budget will last.",
        ["how long will my budget last?", "days left in budget"]
    ),
    "query_most_frequent_purchases": (
        "List your most frequent purchases.",
        ["what do I buy most often?", "most common expenses"]
    ),
    "query_expenses_on_day": (
        "Show expenses on a specific day.",
        ["expenses on March 5th", "what did I spend on July 1?"]
    ),
    "query_1st_savings": (
        "Check the balance or activity in your first savings account.",
        ["how much in first savings?", "show savings 1 activity"]
    ),
    "query_2nd_savings": (
        "Check the balance or activity in your second savings account.",
        ["how much in second savings?", "show savings 2 activity"]
    )
}


INTENT_GROUPS = [
    ("Logging Actions", [
        "log_expense", "log_need_expense", "log_income", "log_rent_paid",
        "log_pge_paid", "log_recology_paid", "log_water_paid",
        "log_1st_savings", "log_2nd_savings", "undo_last_transaction", "delete_recent_action", "query_recent_actions", "update_recent_action", "move_recent_action"
    ]),
    ("Checking Payments", [
        "query_rent_paid", "query_pge_paid", "query_recology_paid", "query_water_paid",
        "query_1st_savings", "query_2nd_savings", "query_subscriptions"
    ]),
    ("Spending & Budget Overview", [
        "query_burn_rate", "query_remaining_budget", "query_projected_spending",
        "query_total_income", "query_average_daily_spend", "query_expense_breakdown_percentages"
    ]),
    ("Category & Item Totals", [
        "query_total_for_store", "query_total_for_category", "query_total_for_item"
    ]),
    ("Largest/Most Frequent Expenses", [
        "query_largest_single_expense", "query_top_n_expenses", "query_most_frequent_purchases",
        "query_highest_expense_category"
    ]),
    ("Time-Based Analysis", [
        "query_spent_this_week", "query_no_spend_days", "query_longest_no_spend_streak",
        "query_days_budget_lasts", "query_expenses_on_day", "query_daily_spending_calendar",
        "query_weekend_vs_weekday", "query_best_worst_day_of_week"
    ])
]


# flattened list of intents
INTENTS = [intent for _, group in INTENT_GROUPS for intent in group]


# === Functions ===
def list_intents():
    output = "**Available Intents:**\n"
    counter = 1
    for group_name, intents in INTENT_GROUPS:
        output += f"\n__{group_name}__\n"
        for intent in intents:
            friendly = get_friendly_name(intent)
            output += f"{counter}. `{friendly}`\n"
            counter += 1
    output += "\n➡️ Type a number (e.g., `4`) to learn more about that intent."
    return output



def describe_intent(number: int) -> str:
    """Return description & examples for selected intent"""
    idx = number - 1
    if idx < 0 or idx >= len(INTENTS):
        return "⚠️ Invalid number. Please choose from the list."

    intent = INTENTS[idx]
    friendly = get_friendly_name(intent)

    description, examples = INTENT_DETAILS.get(intent, ("No description yet.", []))

    output = f"🔷 **{friendly}**\n**Description:** {description}\n"
    if examples:
        output += "**Examples:**\n"
        for ex in examples:
            output += f"• `{ex}`\n"
    else:
        output += "No examples available yet."

    return output


class IntentExplorerSession:
    """Encapsulates the conversational guidance used by the Discord explorer."""

    def __init__(self):
        self._last_selection: Optional[int] = None

    def start_message(self) -> str:
        return (
            "👋 BookieBot explorer ready!\n"
            "• Send `list` any time for the full catalog.\n"
            "• Reply with a number (e.g., `4`) to dive into a specific intent.\n"
            "• Say `repeat` to revisit the last intent.\n"
            "• Type `help` if you need a reminder of the quick commands."
        )

    def help_message(self) -> str:
        """Small command reference that mirrors what we would DM to a user."""

        return (
            "💡 **Explorer tips**\n"
            "• `list` — Show every intent grouped by theme.\n"
            "• `<number>` — e.g., `4` to see details for that intent.\n"
            "• `repeat` — Resend the description you just viewed.\n"
            "• `help` — Show this guide again."
        )

    def handle_message(self, message: str) -> str:
        """Return the response a Discord conversation would send."""

        normalized = message.strip().lower()

        if not normalized:
            return "⚠️ I didn't catch that. Try `list` or pick an intent number."

        if normalized in {"list", "menu", "catalog"}:
            return list_intents()

        if normalized in {"help", "options", "?"}:
            return self.help_message()

        if normalized in {"repeat", "again"}:
            if self._last_selection is None:
                return "⚠️ I haven't shared an intent yet. Pick a number first."

            return describe_intent(self._last_selection)

        if message.strip().isdigit():
            selection = int(message.strip())
            response = describe_intent(selection)

            if not response.startswith("⚠️"):
                self._last_selection = selection

            return response

        return (
            "⚠️ I can show the `list` of intents or explain one if you send its"
            " number. Try `help` for a quick refresher."
        )


def run_navigation_loop():
    """Optional interactive CLI navigation loop"""

    session = IntentExplorerSession()
    print(session.start_message())

    try:
        while True:
            user_input = input(
                "\nType `list` for the menu or reply with a number to explore:\n> "
            )
            print(session.handle_message(user_input))
    except KeyboardInterrupt:
        # Mirror Discord persistence: the session simply stops responding.
        print("\n👋 Ending local explorer session.")


if __name__ == "__main__":
    run_navigation_loop()
