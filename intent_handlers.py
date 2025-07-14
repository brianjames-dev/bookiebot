# all intent handlers

from sheets_writer import write_to_sheet
import sheets_utils as su

INTENT_HANDLERS = {
    "log_expense":                      lambda e, m: write_to_sheet(e, m),
    "log_income":                       lambda e, m: write_to_sheet(e, m),
    "query_burn_rate":                  lambda e, m: query_burn_rate_handler(m),
    "query_rent_paid":                  lambda e, m: query_rent_paid_handler(m),
    "query_utilities_paid":             lambda e, m: query_utilities_paid_handler(m),
    "query_student_loans_paid":         lambda e, m: query_student_loan_paid_handler(m),
    "query_total_spent_at_store":       lambda e, m: query_total_spent_at_store_handler(e, m),
    "query_highest_expense_category":   lambda e, m: query_highest_expense_category_handler(m),
    "query_total_income":               lambda e, m: query_total_income_handler(m),
    "query_remaining_budget":           lambda e, m: query_remaining_budget_handler(m),
    "query_average_daily_spend":        lambda e, m: query_average_daily_spend_handler(m),

    "query_expense_breakdown_percentages": lambda e, m: query_expense_breakdown_handler(m),
    "query_total_for_category":            lambda e, m: query_total_for_category_handler(e, m),
    "query_last_payment_to":               lambda e, m: query_last_payment_to_handler(e, m),
    "query_largest_single_expense":        lambda e, m: query_largest_single_expense_handler(m),
    "query_top_n_expenses":                lambda e, m: query_top_n_expenses_handler(e, m),
    "query_spent_this_week":               lambda e, m: query_spent_this_week_handler(m),
    "query_projected_spending":            lambda e, m: query_projected_spending_handler(m),
    "query_weekend_vs_weekday":            lambda e, m: query_weekend_vs_weekday_handler(m),
    "query_no_spend_days":                 lambda e, m: query_no_spend_days_handler(m),
}

async def handle_intent(intent, entities, message):
    handler = INTENT_HANDLERS.get(intent)
    if not handler:
        await message.channel.send("Sorry, I couldn’t understand your request.")
        return
    await handler(entities, message)

# QUERY HANDLERS
async def query_burn_rate_handler(message):
    burn_rate, desc = await su.calculate_burn_rate()
    if burn_rate and desc:
        await message.channel.send(f"🔥 Burn rate: {burn_rate} ({desc})")
    elif burn_rate:
        await message.channel.send(f"🔥 Burn rate: {burn_rate}")
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
    if breakdown:
        text = "\n".join(f"{k}: {v:.2f}%" for k, v in breakdown.items())
        await message.channel.send(f"📊 Expense breakdown:\n{text}")
    else:
        await message.channel.send("❌ Could not calculate expense breakdown.")

async def query_total_for_category_handler(entities, message):
    category = entities.get("category")
    if not category:
        await message.channel.send("❌ Please specify a category.")
        return
    total = await su.total_for_category(category)
    await message.channel.send(f"💰 You spent ${total:.2f} on {category} this month.")

async def query_last_payment_to_handler(entities, message):
    target = entities.get("vendor_or_category")
    if not target:
        await message.channel.send("❌ Please specify a vendor or category.")
        return
    last_date = await su.last_payment_to(target)
    if last_date:
        await message.channel.send(f"📅 Last payment to {target}: {last_date}")
    else:
        await message.channel.send(f"❌ No payments found for {target} this month.")

async def query_largest_single_expense_handler(message):
    amount, row = await su.largest_single_expense()
    if row:
        await message.channel.send(f"💸 Largest single expense: ${amount:.2f} — details: {row}")
    else:
        await message.channel.send("❌ Could not find any expenses.")

async def query_top_n_expenses_handler(entities, message):
    n = int(entities.get("n", 5))
    top_expenses = await su.top_n_expenses(n)
    if top_expenses:
        text = "\n".join([f"{i+1}. ${amt:.2f} — {row}" for i, (amt, row) in enumerate(top_expenses)])
        await message.channel.send(f"🔝 Top {n} expenses:\n{text}")
    else:
        await message.channel.send("❌ Could not find expenses.")

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
