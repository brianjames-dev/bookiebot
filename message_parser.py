from openai import OpenAI
import os
from dotenv import load_dotenv
from datetime import date

# Load environment variables
load_dotenv()

# Initialize the OpenAI client
client = OpenAI(api_key=os.getenv("OPENAI_API_KEY"))

def parse_message_llm(user_message):
    today = date.today().isoformat()

    system_prompt = f"""
You are a financial assistant. Given a message, extract and return the following as a JSON object:

- type: "expense" or "income"
- amount: float (do not include a $ sign)
- date: always use today's date: {today}

If it's an EXPENSE, also include:
- item: what was bought (e.g., eggs, gas, coffee)
- store: where it was bought (e.g., Trader Joe's, Shell, Ulta)
- category: one of ["grocery", "gas", "food", "shopping"]

Categorize based on:
- "grocery" = food or essentials from grocery stores (Trader Joe’s, Costco, Safeway)
- "gas" = fuel purchases (Shell, Chevron, etc.)
- "food" = restaurants, cafes, or fast food (Chipotle, Starbucks, etc.)
- "shopping" = all other non-food purchases (clothes, gifts, household items)

If it's INCOME, also include:
- source: who sent the money (e.g., Acme Corp, IRS, Mom)
- label: reason or description (e.g., paycheck, birthday gift, tax refund)

Return ONLY a valid JSON object with the correct keys and values. Do not explain anything. Now parse this:
\"\"\"{user_message}\"\"\"
"""


    try:
        response = client.chat.completions.create(
            model="gpt-3.5-turbo",
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_message}
            ],
            temperature=0
        )

        parsed = response.choices[0].message.content
        return parsed

    except Exception as e:
        print("Parsing error:", e)
        return None
