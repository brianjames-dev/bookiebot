import openai
import os
from datetime import date
from dotenv import load_dotenv

load_dotenv()
openai.api_key = os.getenv("OPENAI_API_KEY")

INTENTS = [
    "log_expense",
    "log_income",
    "query_burn_rate",
    "query_rent_paid",
    "query_total_spent_at_store",
    "query_highest_expense_category",
    "query_total_income",
    "query_remaining_budget",
    "query_savings_progress",
    "query_average_daily_spend",
    "query_monthly_goal_status"
]

def parse_message_llm(user_message):
    today = date.today().isoformat()

    system_prompt = f"""
You are a financial assistant. Given a message, identify the user's intent and extract entities if necessary.

Available intents:
{INTENTS}

If the message is logging an expense or income, extract and return:
- intent: "log_expense" or "log_income"
- entities: JSON with relevant fields:
    - type: "expense" or "income"
    - amount: float (without $)
    - date: use today: {today}
    - for expense: also include "item", "location", "category"
    - for income: also include "source", "label"

If the message is a query (not logging), return:
- intent: one of the query intents above
- entities: JSON with any useful parameters (e.g., "store" for a store query), or empty if none

Always return a valid JSON object like:
{{
  "intent": "<intent_name>",
  "entities": {{
    ...
  }}
}}

Do not explain anything. Now parse this:
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
        return response.choices[0].message.content
    except Exception as e:
        print("Parsing error:", e)
        return None
