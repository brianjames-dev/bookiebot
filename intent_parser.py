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
    "query_last_payment_to",
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
You are a financial assistant. Given a message, identify the user's intent and extract entities if necessary.

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

For logging expense or income:
- intent: "log_expense" or "log_income"
- entities: JSON with:
    - type: "expense" or "income"
    - amount: float (without $)
    - date: use today: {today}
    - for expense: also include "item", "location", "category"
    - for income: also include "source", "label"

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
        result = response.choices[0].message.content
        parsed = json.loads(result)
        return parsed
    except Exception as e:
        print("[ERROR] Parsing error:", e)
        return {"intent": "fallback", "entities": {}}
