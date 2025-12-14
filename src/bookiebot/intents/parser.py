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

    If the message is about logging a payment for **rent**, **SMUD**, or **student loan**, use the specific intents:
    - "log_rent_paid" → when paying rent
    - "log_smud_paid" → when paying SMUD (utilities)
    - "log_student_loan_paid" → when paying a student loan

    For these intents, extract the amount paid as:
    - entities: {{ "amount": <float> }}

    Do NOT treat these payments as generic expenses. Do NOT assign them a category. Do NOT include item, location, or store — only use the amount and the correct intent.

    If the message is about logging a Need expense, only include the description of the expense and the amount.
    Do NOT include item, category, location, or other fields. Use the following format:User: "Need expense 45 for bus ticket"
    → {{ "intent": "log_need_expense", "entities": {{ "description": "bus ticket", "amount": 45 }} }}
    User: "Add a Need expense of 75 for car repair"
    → {{ "intent": "log_need_expense", "entities": {{ "description": "car repair", "amount": 75 }} }}

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
