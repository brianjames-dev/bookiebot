import json
from datetime import date
from typing import Any, Dict, Optional

from dotenv import load_dotenv

from bookiebot.intents.explorer import INTENTS
from bookiebot.llm.client import LLMClient, OpenAIClient

load_dotenv()

_DEFAULT_LLM_CLIENT: Optional[LLMClient] = None


def _get_default_client() -> LLMClient:
    global _DEFAULT_LLM_CLIENT
    if _DEFAULT_LLM_CLIENT is None:
        _DEFAULT_LLM_CLIENT = OpenAIClient()
    return _DEFAULT_LLM_CLIENT


async def parse_message_llm(user_message: str, *, llm_client: Optional[LLMClient] = None) -> Dict[str, Any]:
    client = llm_client or _get_default_client()
    today = date.today().isoformat()

    system_prompt = f"""
    You are a financial assistant named BookieBot located in the PST time zone. Given a message, identify the user's intent and extract entities if necessary.

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

    If the message asks to undo, remove, reverse, or delete the most recently logged BookieBot transaction without specifying a store, item, category, or other target, use:
    - intent: "undo_last_transaction"
    - entities: {{}}

    If the message asks to remove, delete, clear, undo, or reverse a specific recent logged action, such as a Chipotle expense or a numbered/id action from a recent action list, use:
    - intent: "delete_recent_action"
    - entities: {{
        "index": <number if the user identifies a numbered action>,
        "action_id": "<id if provided>",
        "match_text": "<store/item/description/category text such as Chipotle if provided>"
      }}

    If the message asks to delete, remove, clear, change, edit, update, fix, or correct an expense/transaction/action but does NOT specify which one, use:
    - intent: "query_recent_actions"
    - entities: {{ "n": 5 }}

    If the message asks to change, edit, update, fix, redo, or correct a recently logged BookieBot action, but does not provide an exact action id or enough detail to safely edit a cell, use:
    - intent: "query_recent_actions"
    - entities: {{ "n": 5 }}

    If the message asks to change, edit, update, fix, redo, or correct a recently logged BookieBot action and includes the target plus the requested field change, use:
    - intent: "update_recent_action"
    - entities: {{
        "index": <1 for "last one", or explicit number if provided>,
        "action_id": "<id if provided>",
        "match_text": "<store/item/description text such as Chipotle if provided>",
        "updates": {{
            "amount": <float if changing amount>,
            "location": "<new location if changing location>",
            "item": "<new item/name if changing item>",
            "person": "<new person/card if changing card/person>",
            "date": "<new date if changing date>"
        }}
      }}

    If the message asks to move, recategorize, reclassify, or change the category of a recent expense, use:
    - intent: "move_recent_action"
    - entities: {{
        "index": <number if the user identifies a numbered action>,
        "action_id": "<id if provided>",
        "match_text": "<store/item/description text such as Chipotle if provided>",
        "category": "<destination category: grocery, gas, food, shopping, or need_expenses>",
        "updates": {{
            "item": "<item if needed for the destination category>",
            "amount": <float if correcting amount too>,
            "location": "<location if correcting location too>",
            "person": "<person/card if correcting person too>",
            "date": "<date if correcting date too>"
        }}
      }}

    If the message asks to show or list recent logged actions, undo history, edit candidates, or the last N actions, use:
    - intent: "query_recent_actions"
    - entities: {{ "n": <integer if provided, otherwise 5>, "explicit_n": <true only if the user asked for a specific number> }}

    If the message is about logging a payment for **rent**, **PG&E**, **Recology/trash**, or **water**, use the specific intents:
    - "log_rent_paid" → when paying rent
    - "log_pge_paid" → when paying PG&E / PGE / gas and electric utilities
    - "log_recology_paid" → when paying Recology, trash, garbage, or waste bills
    - "log_water_paid" → when paying water, water bill, or Santa Rosa Water

    For these intents, extract the amount paid as:
    - entities: {{ "amount": <float> }}

    Do NOT treat these payments as generic expenses. Do NOT assign them a category. Do NOT include item, location, or store — only use the amount and the correct intent.

    Student loan payments are tracked as subscription autopay and do not have log-payment or paid-status intents. If a message asks to log or check a student loan payment, return the fallback intent instead of treating it as a generic expense or another payment type.

    If the message is about a savings contribution tied to a numbered paycheck, use the matching numbered savings intent:
    - "log_1st_savings", "log_2nd_savings", or "log_3rd_savings" when recording an amount
    - "query_1st_savings", "query_2nd_savings", or "query_3rd_savings" when checking whether it was deposited
    For logging, extract entities as: {{ "amount": <float> }}.

    If the message is about logging a Need expense, use the same separated expense fields as other shared expenses:
    - amount: float (do not include $)
    - item: short label for what was purchased or paid for
    - location: merchant, vendor, or place when provided or reasonably inferable
    - person: only when explicitly provided; otherwise omit it so the Discord user is used
    Do NOT include a category or date; the handler routes it to the shared Needs category and timestamps it.
    User: "Need expense 45 for bus ticket at Golden Gate Transit"
    → {{ "intent": "log_need_expense", "entities": {{ "item": "bus ticket", "location": "Golden Gate Transit", "amount": 45 }} }}
    User: "Add a Need expense of 75 for car repair at Midas"
    → {{ "intent": "log_need_expense", "entities": {{ "item": "car repair", "location": "Midas", "amount": 75 }} }}

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

    ❗ Do NOT leave "item" blank — if unsure, infer based on the location or context (e.g., "coffee" for Starbucks).

    Valid options for the "person" field are:
    - "Hannah"
    - "Brian (BofA)"
    - "Brian (AL)"
    - "TOTAL" (for combined totals)

    If the message clearly mentions one of these names or "TOTAL", include it as `"person": "<name>"` in the entities.
    If the message mentions "Brian", assume it refers to **both of Brian’s accounts combined** — leave `"person": "Brian"` to signal this, and the downstream code will sum both `"Brian (BofA)"` and `"Brian (AL)"`.
    If the message specifically mentions **“on my AL card”** or **“on my Alaska card”**, set `"person": "Brian (AL)"`.
    If the message specifically mentions **“on my BofA card”**, set `"person": "Brian (BofA)"`.
    If no name is specified, and no "TOTAL" is mentioned, leave out `"person"` and default to the Discord user’s name.If no name or "TOTAL" is explicitly mentioned in the message, leave "person" out of entities.

    Categorize EXPENSE as:
    - "grocery" = food or essentials from grocery stores (Trader Joe’s, Costco, Safeway). If the word "groceries" is mentioned, always choose "grocery".
    - "gas" = fuel purchases (Shell, Chevron, etc.)
    - "food" = restaurants, cafes, or fast food (Chipotle, Starbucks, etc.) — if not explicitly "groceries", but clearly food-related
    - "shopping" = all other non-food, non-grocery, non-gas purchases (clothes, gifts, household items)

    If the location or description does NOT clearly match one of the 4 categories ["grocery", "gas", "food", "shopping"], assume it refers to a specific store or vendor, and extract it as the 'store' entity.

    If the message is about logging INCOME, also include:
        - source: who sent the money (e.g., Acme Corp, IRS, Mom)
        - label: reason or description (e.g., paycheck, birthday gift, tax refund)

    If the message is a QUERY (not logging), return:
    - intent: one of the query intents from the list above
    - entities: JSON with any useful parameters (e.g., "store" for a store query, "category", "vendor", "n" for top-n queries), or empty if none.

    If a query mentions a month or period, include it as `"month"` using the user's wording when possible, such as:
    - "June" → entities includes {{ "month": "June" }}
    - "June 2026" → entities includes {{ "month": "June 2026" }}
    - "last month" → entities includes {{ "month": "last month" }}
    If no month is mentioned, omit `"month"` so the app can default to the current month.

    Always return ONLY a valid JSON object with the correct keys and values. Do not explain anything.  

    Now parse this:
    \"\"\"{user_message}\"\"\"
    """

    try:
        raw_response = await client.complete(
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_message},
            ],
            temperature=0,
        )
        if isinstance(raw_response, str):
            parsed = json.loads(raw_response)
        elif isinstance(raw_response, dict):
            parsed = raw_response
        else:
            raise ValueError("LLM response must be JSON string or dict.")
        return parsed
    except Exception as e:
        print("[ERROR] Parsing error:", e)
        return {"intent": "fallback", "entities": {}}
