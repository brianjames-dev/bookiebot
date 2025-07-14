import openai
import os
import json
from datetime import date
from dotenv import load_dotenv

load_dotenv()
openai.api_key = os.getenv("OPENAI_API_KEY")

INTENTS_WITH_EXAMPLES = {
    "log_expense": [
        "I spent $5 on coffee at Starbucks",
        "Logged a $40 gas fill-up at Shell",
        "Bought groceries at Trader Joe’s for $75"
    ],
    "log_income": [
        "I got paid $1500 from Acme Corp for my paycheck",
        "Received $200 birthday gift from Mom",
        "IRS sent me a $500 tax refund"
    ],
    "query_burn_rate": [
        "What’s my monthly burn rate?",
        "How fast am I burning through my budget?"
    ],
    "query_rent_paid": [
        "Have I paid my rent this month?",
        "What did I pay for rent?"
    ],
    "query_utilities_paid": [
        "How much have I paid for utilities?",
        "What did I spend on water, gas, and electricity?"
    ],
    "query_student_loans_paid": [
        "How much have I paid toward student loans?",
        "Student loan payments this month?"
    ],
    "query_total_spent_at_store": [
        "How much have I spent at 7/11?",
        "What’s my total at In and Out?",
        "Spending at Russian River?"
    ],
    "query_highest_expense_category": [
        "Which category did I spend the most in?",
        "What’s my highest expense category this month?"
    ],
    "query_total_income": [
        "What’s my total income this month?",
        "How much money have I earned?"
    ],
    "query_remaining_budget": [
        "How much budget do I have left?",
        "Remaining budget for this month?"
    ],
    "query_average_daily_spend": [
        "What’s my average daily spend?",
        "How much do I spend on average per day?"
    ],
    "query_expense_breakdown_percentages": [
        "Show me my expense breakdown by category",
        "What percentage of my spending was on food, shopping, etc.?"
    ],
    "query_total_for_category": [
        "How much have I spent on food?",
        "What did I spend on shopping this month?",
        "Show me my total gas spending"
    ],
    "query_largest_single_expense": [
        "What was my biggest single expense?",
        "Largest purchase this month?"
    ],
    "query_top_n_expenses": [
        "What are my top 3 expenses?",
        "Show me the 5 biggest purchases this month"
    ],
    "query_spent_this_week": [
        "How much have I spent so far this week?",
        "Total spending this week?"
    ],
    "query_projected_spending": [
        "What’s my projected spending for this month?",
        "Estimate my spending by the end of the month"
    ],
    "query_weekend_vs_weekday": [
        "Compare my weekend vs weekday spending",
        "How much do I spend on weekends compared to weekdays?"
    ],
    "query_no_spend_days": [
        "How many no-spend days have I had this month?",
        "List the days I didn’t spend anything"
    ]
}

INTENTS = list(INTENTS_WITH_EXAMPLES.keys())

def parse_message_llm(user_message):
    today = date.today().isoformat()

    examples_text = ""
    for intent, examples in INTENTS_WITH_EXAMPLES.items():
        examples_text += f"\nIntent: {intent}\n"
        for ex in examples:
            examples_text += f'User: "{ex}"\n→ {{"intent": "{intent}", "entities": {{...}}}}\n'

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

If the message is about logging an expense or income:
- intent: "log_expense" or "log_income"
- entities: JSON with:
    - type: "expense" or "income"
    - amount: float (do not include $)
    - date: always use today's date: {today}

If it's an EXPENSE, also include:
    - item: short label for what was bought (e.g., "coffee", "gas", "groceries", or "Starbucks reload")
    - location: where it was bought (e.g., Trader Joe's, Shell, Ulta)
    - category: one of ["grocery", "gas", "food", "shopping"]

❗ Do not leave "item" blank — if unsure, infer based on the location or context (e.g., "coffee" for Starbucks).
❗ Do NOT include a "person" field — the bot determines the person based on Discord user.

Categorize EXPENSE as:
- "grocery" = food or essentials from grocery stores (Trader Joe’s, Costco, Safeway). If the word "groceries" is mentioned, always choose "grocery".
- "gas" = fuel purchases (Shell, Chevron, etc.)
- "food" = restaurants, cafes, or fast food (Chipotle, Starbucks, etc.) — if not explicitly "groceries", but clearly food-related
- "shopping" = all other non-food, non-grocery, non-gas purchases (clothes, gifts, household items)

If the message is about logging INCOME, also include:
    - source: who sent the money (e.g., Acme Corp, IRS, Mom)
    - label: reason or description (e.g., paycheck, birthday gift, tax refund)

If the message is a QUERY (not logging), return:
- intent: one of the query intents from the list above
- entities: JSON with any useful parameters (e.g., "store" for a store query, "category", "vendor", "n" for top-n queries), or empty if none.

Here are some examples of how to respond:
{examples_text}

Always return ONLY a valid JSON object with the correct keys and values. Do not explain anything.  

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
