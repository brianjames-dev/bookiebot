import openai
import os
import json
from datetime import date
from dotenv import load_dotenv

load_dotenv()
openai.api_key = os.getenv("OPENAI_API_KEY")

INTENTS = [
    "log_expense",
    "log_income",
    "query_burn_rate",
    "query_rent_paid",
    "query_utilities_paid",
    "query_student_loans_paid",
    "query_total_spent_at_store",
    "query_highest_expense_category",
    "query_total_income",
    "query_remaining_budget",
    "query_average_daily_spend",
    "query_expense_breakdown_percentages",
    "query_total_for_category",
    "query_largest_single_expense",
    "query_top_n_expenses",
    "query_spent_this_week",
    "query_projected_spending",
    "query_weekend_vs_weekday",
    "query_no_spend_days"
]


def parse_message_llm(user_message):
    today = date.today().isoformat()

    system_prompt = f"""
You are a financial assistant named BookieBot.  
Given a message, identify the user's intent and extract entities if necessary.

Available intents:
{INTENTS}

If the message clearly matches one of the available intents above, return:
{{
  "intent": "<intent_name>",
  "entities": {{ ... }}
}}

If the message does NOT clearly match any available intent, return:
{{
  "intent": "fallback",
  "entities": {{}}
}}

If the message is about logging an expense or income:
- intent: "log_expense" or "log_income"
- entities: JSON with:
    - type: "expense" or "income"
    - amount: float (do not include $)
    - date: always use today's date: {today}

If it's an EXPENSE, also include:
    - item: short label for what was bought (e.g., "coffee", "groceries", "gas")
    - location: where it was bought (e.g., Trader Joe's, Shell, Starbucks)
    - category: one of ["grocery", "gas", "food", "shopping"]

If it's an INCOME, also include:
    - source: who sent the money (e.g., Acme Corp, IRS, Mom)
    - label: reason or description (e.g., paycheck, birthday gift, tax refund)

If the message is a QUERY (not logging), return:
- intent: one of the query intents from the list above
- entities: JSON with any useful parameters (e.g., "store" for a store query, "category", "n" for top-n queries), or empty if none.

❗ Do NOT explain or apologize — only return JSON.
❗ Do NOT say you cannot access data — always return the intent & store as provided.
❗ Do NOT leave "item" blank — if unsure, infer based on the location or context (e.g., "coffee" for Starbucks).
❗ Do NOT include a "person" field — the bot determines the person based on Discord user.
❗ Always assume any store name the user provides is valid — even if you do not recognize it.

Examples of the kind of JSON you should produce:
- Log Expense: {{ "intent": "log_expense", "entities": {{ "type": "expense", "amount": 15.0, "date": "{today}", "item": "coffee", "location": "Starbucks", "category": "food" }} }}
- Query Store: {{ "intent": "query_total_spent_at_store", "entities": {{ "store": "In N Out" }} }}
- Query Store: {{ "intent": "query_total_spent_at_store", "entities": {{ "store": "Russian River" }} }}
- Query Store: {{ "intent": "query_total_spent_at_store", "entities": {{ "store": "Mom's Deli" }} }}
- Query Category: {{ "intent": "query_total_for_category", "entities": {{ "category": "food" }} }}
- Query Top N: {{ "intent": "query_top_n_expenses", "entities": {{ "n": 5 }} }}
- Query Burn Rate: {{ "intent": "query_burn_rate", "entities": {{}} }}

Now parse this:
\"\"\"{user_message}\"\"\"
"""

    try:
        response = openai.ChatCompletion.create(
            model="gpt-3.5-turbo",
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_message}
            ],
            temperature=0
        )
        result = response.choices[0].message.content
        parsed = json.loads(result)
        return parsed
    except Exception as e:
        print("[ERROR] Parsing error:", e)
        return {"intent": "fallback", "entities": {}}
