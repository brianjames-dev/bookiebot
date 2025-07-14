# all intent handlers

from sheets_writer import write_to_sheet
import sheets_utils as su
import openai

INTENT_HANDLERS = {
    "log_expense":                          lambda e, m: write_to_sheet(e, m),
    "log_income":                           lambda e, m: write_to_sheet(e, m),
    "query_burn_rate":                      lambda e, m: query_burn_rate_handler(m),
    "query_rent_paid":                      lambda e, m: query_rent_paid_handler(m),
    "query_utilities_paid":                 lambda e, m: query_utilities_paid_handler(m),
    "query_student_loans_paid":             lambda e, m: query_student_loan_paid_handler(m),
    "query_total_spent_at_store":           lambda e, m: query_total_spent_at_store_handler(e, m),
    "query_highest_expense_category":       lambda e, m: query_highest_expense_category_handler(m),
    "query_total_income":                   lambda e, m: query_total_income_handler(m),
    "query_remaining_budget":               lambda e, m: query_remaining_budget_handler(m),
    "query_average_daily_spend":            lambda e, m: query_average_daily_spend_handler(m),
    "query_expense_breakdown_percentages":  lambda e, m: query_expense_breakdown_handler(m),
    "query_total_for_category":             lambda e, m: query_total_for_category_handler(e, m),
    "query_largest_single_expense":         lambda e, m: query_largest_single_expense_handler(m),
    "query_top_n_expenses":                 lambda e, m: query_top_n_expenses_handler(e, m),
    "query_spent_this_week":                lambda e, m: query_spent_this_week_handler(m),
    "query_projected_spending":             lambda e, m: query_projected_spending_handler(m),
    "query_weekend_vs_weekday":             lambda e, m: query_weekend_vs_weekday_handler(m),
    "query_no_spend_days":                  lambda e, m: query_no_spend_days_handler(m),
}

# INTENT HANDLER
async def handle_intent(intent, entities, message, last_context=None):
    handler = INTENT_HANDLERS.get(intent)
    if not handler or intent == "fallback":
        await fallback_handler(message.content, message, context=last_context)
        return
    await handler(entities, message)

# FALLBACK HANDLER
async def fallback_handler(user_message, message, context=None):
    """
    If no intent matched, use GPT to generate a general helpful response.
    Optionally include context from last output.
    """
    prompt = f"""
You are a helpful financial assistant. The user previously saw this context (if any):
\"\"\"{context}\"\"\"

Now the user asks:
\"\"\"{user_message}\"\"\"

Please respond helpfully and clearly.
"""
    try:
        response = openai.ChatCompletion.create(
            model="gpt-3.5-turbo",
            messages=[
                {"role": "system", "content": "You are a financial assistant chatbot."},
                {"role": "user", "content": prompt}
            ],
            temperature=0.5
        )
        reply = response.choices[0].message.content
        await message.channel.send(reply)
    except Exception as e:
        print("[ERROR] fallback_handler failed:", e)
        await message.channel.send("❌ Sorry, I couldn't process your request.")

# QUERY HANDLERS
async def query_burn_rate_handler(message):
    burn_rate, desc = await su.calculate_burn_rate()
    if burn_rate and desc:
        await message.channel.send(f"🔥 Burn rate:\n You are allowed to spend {burn_rate}\n\n ({desc})")
    elif burn_rate:
        await message.channel.send(f"🔥 Burn rate:\n You are allowed to spend {burn_rate}")
    else:
        await message.channel.send("❌ Could not determine burn rate.")

async def query_rent_paid_handler(message):
    paid, amount = await su.check_rent_paid()
    if paid:
        await message.channel.send(f"✅ You paid ${amount:.2f} for rent this month.")
    else:
        await message.channel.send("❌ You have NOT paid rent yet this month.")

async def query_utilities_paid_handler(message):
    paid, amount = await su.check_utilities_paid()
    if paid:
        await message.channel.send(f"✅ You paid ${amount:.2f} for utilities this month.")
    else:
        await message.channel.send("❌ You have NOT paid utilities yet this month.")

async def query_student_loan_paid_handler(message):
    paid, amount = await su.check_student_loan_paid()
    if paid:
        await message.channel.send(f"✅ You paid ${amount:.2f} for student loans this month.")
    else:
        await message.channel.send("❌ You have NOT made a student loan payment yet this month.")

async def query_total_spent_at_store_handler(entities, message):
    store = entities.get("store")
    amount = await su.total_spent_at_store(store)
    await message.channel.send(f"You’ve spent ${amount:.2f} at {store} this month.")

async def query_highest_expense_category_handler(message):
    category, amount = await su.highest_expense_category()
    await message.channel.send(f"Highest expense category: {category} (${amount:.2f}).")

async def query_total_income_handler(message):
    income = await su.total_income()
    await message.channel.send(f"Total income this month: ${income:.2f}.")

async def query_remaining_budget_handler(message):
    remaining = await su.remaining_budget()
    if remaining >= 0:
        await message.channel.send(
            f"Remaining spending budget this month: ${remaining:.2f}."
        )
    elif remaining < 0:
        await message.channel.send(
            f"You're currently exceeding this month's spending budget by ${abs(remaining):.2f}."
        )
    else:
        await message.channel.send(
            "Sorry, I couldn’t determine your remaining budget."
        )

async def query_average_daily_spend_handler(message):
    avg = await su.average_daily_spend()
    await message.channel.send(f"Average daily spend this month: ${avg:.2f}.")

## DEBUG THESE:
async def query_expense_breakdown_handler(message):
    breakdown = await su.expense_breakdown_percentages()
    if not breakdown:
        await message.channel.send("❌ Could not calculate expense breakdown.")
        return

    lines = []
    for category, info in breakdown.items():
        amt = info.get("amount", 0.0)
        pct = info.get("percentage", 0.0)
        lines.append(f"{category.capitalize()}: ${amt:.2f} ({pct:.2f}%)")

    text = "\n".join(lines)
    await message.channel.send(f"📊 Expense breakdown:\n{text}")

async def query_total_for_category_handler(entities, message):
    category = entities.get("category")
    if not category:
        await message.channel.send("❌ Please specify a category.")
        return
    total = await su.total_for_category(category)
    await message.channel.send(f"💰 You spent ${total:.2f} on {category} this month.")

async def query_largest_single_expense_handler(message):
    amount, row = await su.largest_single_expense()
    if row:
        await message.channel.send(f"💸 Largest single expense: ${amount:.2f} — details: {row}")
    else:
        await message.channel.send("❌ Could not find any expenses.")

async def query_top_n_expenses_handler(entities, message):
    n = int(entities.get("n", 5))
    top_expenses = await su.top_n_expenses_food_and_shopping(n)

    if not top_expenses:
        await message.channel.send("❌ Could not find any expenses.")
        return

    # Build message
    lines = []
    for i, expense in enumerate(top_expenses, 1):
        lines.append(
            f"{i}. ${expense['amount']:.2f} — {expense['item']} "
            f"at {expense['location']} on {expense['date']} "
            f"({expense['category']})"
        )

    text = "\n".join(lines)
    await message.channel.send(f"🔝 Top {n} expenses:\n{text}")


async def query_spent_this_week_handler(message):
    total = await su.spent_this_week()
    await message.channel.send(f"📆 You’ve spent ${total:.2f} so far this week.")

async def query_projected_spending_handler(message):
    projected = await su.projected_spending()
    await message.channel.send(f"📈 Projected spending for this month: ${projected:.2f}")

async def query_weekend_vs_weekday_handler(message):
    weekend, weekday = await su.weekend_vs_weekday()
    await message.channel.send(
        f"🌞 Weekends: ${weekend:.2f}\n📅 Weekdays: ${weekday:.2f}"
    )

async def query_no_spend_days_handler(message):
    count, days = await su.no_spend_days()
    days_str = ", ".join(str(d) for d in days)
    await message.channel.send(
        f"🚫 No-spend days this month: {count}\nDays: {days_str}"
    )
