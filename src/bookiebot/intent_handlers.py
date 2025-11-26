# all intent handlers

from bookiebot.sheets_writer import write_to_sheet
import bookiebot.sheets_utils as su
import openai
import matplotlib.pyplot as plt
import io
from datetime import datetime
from bookiebot.sheets_utils import resolve_query_persons, get_local_today

try:
    import discord
except ImportError:  # pragma: no cover - fallback for tests without discord.py
    class _Discord:
        class File:
            def __init__(self, fp, filename):
                self.fp = fp
                self.filename = filename

    discord = _Discord()

INTENT_HANDLERS = {
    # Logging handlers
    "log_expense":                          lambda e, m: write_to_sheet(e, m),
    "log_income":                           lambda e, m: write_to_sheet(e, m),
    "log_rent_paid":                        lambda e, m: log_rent_paid_handler(e, m),
    "log_smud_paid":                        lambda e, m: log_smud_paid_handler(e, m),
    "log_student_loan_paid":                lambda e, m: log_student_loan_paid_handler(e, m),
    "log_1st_savings":                      lambda e, m: log_1st_savings_handler(e, m),
    "log_2nd_savings":                      lambda e, m: log_2nd_savings_handler(e, m),
    "log_need_expense":                     lambda e, m: log_need_expense_handler(e, m),

    # Query handlers
    "query_burn_rate":                      lambda e, m: query_burn_rate_handler(m),
    "query_rent_paid":                      lambda e, m: query_rent_paid_handler(m),
    "query_smud_paid":                      lambda e, m: query_smud_paid_handler(m),
    "query_student_loans_paid":             lambda e, m: query_student_loan_paid_handler(m),
    "query_total_for_store":                lambda e, m: query_total_for_store_handler(e, m),
    "query_highest_expense_category":       lambda e, m: query_highest_expense_category_handler(e, m),
    "query_total_income":                   lambda e, m: query_total_income_handler(m),
    "query_remaining_budget":               lambda e, m: query_remaining_budget_handler(m), 
    "query_average_daily_spend":            lambda e, m: query_average_daily_spend_handler(e, m),
    "query_expense_breakdown_percentages":  lambda e, m: query_expense_breakdown_handler(e, m),
    "query_total_for_category":             lambda e, m: query_total_for_category_handler(e, m),
    "query_largest_single_expense":         lambda e, m: query_largest_single_expense_handler(e, m),
    "query_top_n_expenses":                 lambda e, m: query_top_n_expenses_handler(e, m),
    "query_spent_this_week":                lambda e, m: query_spent_this_week_handler(e, m),
    "query_projected_spending":             lambda e, m: query_projected_spending_handler(e, m),
    "query_weekend_vs_weekday":             lambda e, m: query_weekend_vs_weekday_handler(e, m),
    "query_no_spend_days":                  lambda e, m: query_no_spend_days_handler(e, m),
    "query_total_for_item":                 lambda e, m: query_total_for_item_handler(e, m),
    "query_subscriptions":                  lambda e, m: query_subscriptions_handler(m),
    "query_daily_spending_calendar":        lambda e, m: query_daily_spending_calendar_handler(e, m),
    "query_best_worst_day_of_week":         lambda e, m: query_best_worst_day_of_week_handler(e, m),
    "query_longest_no_spend_streak":        lambda e, m: query_longest_no_spend_streak_handler(e, m),
    "query_days_budget_lasts":              lambda e, m: query_days_budget_lasts_handler(m),
    "query_most_frequent_purchases":        lambda e, m: query_most_frequent_purchases_handler(e, m),
    "query_expenses_on_day":                lambda e, m: query_expenses_on_day_handler(e, m),
    "query_1st_savings":                    lambda e, m: query_1st_savings_handler(e, m),
    "query_2nd_savings":                    lambda e, m: query_2nd_savings_handler(e, m),
}


# INTENT HANDLER
async def handle_intent(intent, entities, message, last_context=None):
    handler = INTENT_HANDLERS.get(intent)
    if not handler or intent == "fallback":
        await fallback_handler(message.content, message, context=last_context)
        return

    if "person" not in entities or not entities["person"]:
        print(f"👤 No person specified, letting resolver handle Discord user: {message.author.name}")
        entities["person"] = None

    # For query intents, resolve to actual list of person(s)
    if intent.startswith("query_"):
        discord_user = message.author.name.lower()
        person = entities.get("person")
        persons_to_query = resolve_query_persons(discord_user, person)

        if not persons_to_query:
            await message.channel.send("❌ Could not resolve person(s) to query.")
            return

        # overwrite person in entities with resolved list
        entities["persons"] = persons_to_query
        print(f"🔎 Resolved persons for query: {persons_to_query}")

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
        await message.channel.send(f"🔥 Burn rate: You are allowed to spend {burn_rate}\n\n {desc}")
    elif burn_rate:
        await message.channel.send(f"🔥 Burn rate: You are allowed to spend {burn_rate}")
    else:
        await message.channel.send("❌ Could not determine burn rate.")


async def query_rent_paid_handler(message):
    paid, amount = await su.check_rent_paid()
    if paid:
        await message.channel.send(f"✅ You paid ${amount:.2f} for rent this month.")
    else:
        await message.channel.send("❌ You have NOT paid rent yet this month.")


async def query_smud_paid_handler(message):
    paid, amount = await su.check_smud_paid()
    if paid:
        await message.channel.send(f"✅ You paid ${amount:.2f} for SMUD this month.")
    else:
        await message.channel.send("❌ You have NOT paid SMUD yet this month.")


async def query_student_loan_paid_handler(message):
    paid, amount = await su.check_student_loan_paid()
    if paid:
        await message.channel.send(f"✅ You paid ${amount:.2f} for student loans this month.")
    else:
        await message.channel.send("❌ You have NOT made a student loan payment yet this month.")


async def query_total_for_store_handler(entities, message):
    store = entities.get("store")
    persons_to_query = entities.get("persons")  # <-- already resolved in handle_intent

    if not store:
        await message.channel.send("❌ Please specify a store.")
        return
    if not persons_to_query:
        await message.channel.send("❌ Could not determine person(s) to query.")
        return

    total, matches = await su.total_spent_at_store(store, persons_to_query)

    response = f"💰 You’ve spent ${total:.2f} at {store} this month.\n"
    if matches:
        response += "\n**Top transactions:**\n"
        for date_obj, location, amount, category in matches:
            date_str = date_obj.strftime("%m/%d")
            response += f"- {date_str}: ${amount:.2f} at {location} ({category})\n"
    else:
        response += "\n*(No transactions found this month.)*"

    await message.channel.send(response)



async def query_highest_expense_category_handler(entities, message):
    discord_user = message.author.name.lower()
    persons_to_query = resolve_query_persons(discord_user, entities.get("person"))

    if not persons_to_query:
        await message.channel.send("❌ Could not resolve person(s) to query.")
        return

    category, amount = await su.highest_expense_category(persons_to_query)
    await message.channel.send(f"📊 Highest expense category: {category} (${amount:.2f}).")


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


async def query_average_daily_spend_handler(entities, message):
    persons = entities.get("persons")
    if not persons:
        await message.channel.send("❌ Could not determine person(s) to query.")
        return

    avg = await su.average_daily_spend(persons)
    if avg is not None:
        await message.channel.send(f"📊 Average daily spend this month: ${avg:.2f}.")
    else:
        await message.channel.send("❌ Could not calculate average daily spend.")


async def query_expense_breakdown_handler(entities, message):
    persons = entities.get("persons")
    if not persons:
        await message.channel.send("❌ Could not determine person(s) to query.")
        return

    breakdown = await su.expense_breakdown_percentages(persons)

    if not breakdown:
        await message.channel.send("❌ Could not calculate expense breakdown.")
        return

    # Prepare data
    labels = []
    amounts = []
    lines = []

    for category, info in breakdown["categories"].items():
        amt = info["amount"]
        pct = info["percentage"]

        if amt == 0:
            continue  # 🚨 skip 0 categories

        labels.append(f"{category.capitalize()}\n(${amt:.2f})")
        amounts.append(amt)
        lines.append(f"{category.capitalize()}: ${amt:.2f} ({pct:.2f}%)")

    people_str = ", ".join(persons)
    grand_total = breakdown["grand_total"]

    # Build text breakdown
    text = "\n".join(lines)
    text = f"📊 Expense breakdown for {people_str}:\n{text}\n\n💵 Total: ${grand_total:.2f}"

    # Pie Chart
    fig, ax = plt.subplots(figsize=(6, 6))
    colors = plt.get_cmap('Pastel1').colors

    largest_idx = amounts.index(max(amounts))
    explode = [0.1 if i == largest_idx else 0 for i in range(len(amounts))]

    wedges, texts, autotexts = ax.pie(
        amounts,
        labels=labels,
        autopct='%1.1f%%',
        startangle=140,
        shadow=True,
        colors=colors,
        explode=explode,
        radius=0.9,
        textprops={'fontsize': 10}
    )

    for autotext in autotexts:
        autotext.set_fontsize(11)
        autotext.set_fontweight('bold')

    ax.set_title(
        f"Expense Breakdown\nTotal: ${grand_total:.2f}",
        fontsize=16,
        fontweight='bold',
        pad=10
    )

    ax.axis('equal')

    plt.tight_layout()

    buf = io.BytesIO()
    plt.savefig(buf, format='png', dpi=150)
    buf.seek(0)
    plt.close(fig)

    file = discord.File(fp=buf, filename="expense_breakdown.png")

    await message.channel.send(content=text, file=file)


async def query_total_for_category_handler(entities, message):
    category = entities.get("category")
    persons = entities.get("persons")

    if not category:
        await message.channel.send("❌ Please specify a category.")
        return
    if not persons:
        await message.channel.send("❌ Could not determine person(s) to query.")
        return

    total = await su.total_for_category(category, persons)
    await message.channel.send(
        f"💰 Total spent on **{category.capitalize()}** this month: ${total:.2f}."
    )


async def query_largest_single_expense_handler(entities, message):
    persons = entities.get("persons")
    if not persons:
        await message.channel.send("❌ Could not determine person(s) to query.")
        return

    result = await su.largest_single_expense(persons)
    if result:
        await message.channel.send(
            f"💸 Largest single expense: ${result['amount']:.2f} — "
            f"{result['item']} at {result['location']} on {result['date']} "
            f"({result['category']})"
        )
    else:
        await message.channel.send("❌ Could not find any expenses.")


async def query_top_n_expenses_handler(entities, message):
    n = int(entities.get("n", 5))
    persons = entities.get("persons")
    if not persons:
        await message.channel.send("❌ Could not determine person(s) to query.")
        return

    top_expenses = await su.top_n_expenses_all_categories(persons, n)

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


async def query_spent_this_week_handler(entities, message):
    persons = entities.get("persons")
    if not persons:
        await message.channel.send("❌ Could not determine person(s) to query.")
        return

    total = await su.spent_this_week(persons)
    await message.channel.send(f"📆 You’ve spent ${total:.2f} so far this week.")


async def query_projected_spending_handler(entities, message):
    persons = entities.get("persons")
    if not persons:
        await message.channel.send("❌ Could not determine person(s) to query.")
        return

    projected = await su.projected_spending(persons)
    await message.channel.send(f"📈 Projected spending for this month: ${projected:,.2f}")


async def query_weekend_vs_weekday_handler(entities, message):
    persons = entities.get("persons")
    if not persons:
        await message.channel.send("❌ Could not determine person(s) to query.")
        return

    weekend, weekday = await su.weekend_vs_weekday(persons)
    await message.channel.send(
        f"🌞 Weekends: ${weekend:.2f}\n📅 Weekdays: ${weekday:.2f}"
    )


async def query_no_spend_days_handler(entities, message):
    persons = entities.get("persons")
    if not persons:
        await message.channel.send("❌ Could not determine person(s) to query.")
        return

    count, days = await su.no_spend_days(persons)
    days_str = ", ".join(str(d) for d in days)
    await message.channel.send(
        f"🚫 No-spend days this month: {count}\nDays: {days_str}"
    )


async def query_total_for_item_handler(entities, message):
    item = entities.get("item")
    persons = entities.get("persons")

    if not item:
        await message.channel.send("❌ Please specify an item.")
        return
    if not persons:
        await message.channel.send("❌ Could not determine person(s) to query.")
        return

    total, matches = await su.total_spent_on_item(item, persons)

    response = f"💰 You’ve spent ${total:.2f} on {item} this month.\n"
    if matches:
        response += "\n**Top transactions:**\n"
        for date_obj, item_name, amount, category, person in matches:
            date_str = date_obj.strftime("%m/%d")
            response += f"- {date_str}: ${amount:.2f} for {item_name} ({category}, {person})\n"
    else:
        response += "\n*(No transactions found this month.)*"

    await message.channel.send(response)


async def query_daily_spending_calendar_handler(entities, message):
    persons = entities.get("persons")
    if not persons:
        await message.channel.send("❌ Could not determine person(s) to query.")
        return

    text_summary, chart_file = await su.daily_spending_calendar(persons)
    await message.channel.send(
        content=f"📆 Here is your daily spending calendar:\n\n{text_summary}",
        file=chart_file
    )


async def query_best_worst_day_of_week_handler(entities, message):
    persons = entities.get("persons")
    if not persons:
        await message.channel.send("❌ Could not determine person(s) to query.")
        return

    result = await su.best_worst_day_of_week(persons)
    best_day, best_avg = result["best"]
    worst_day, worst_avg = result["worst"]

    response = (
        f"📅 Best (lowest) day: {best_day} — ${best_avg:.2f} avg\n"
        f"💸 Worst (highest) day: {worst_day} — ${worst_avg:.2f} avg"
    )

    await message.channel.send(response)


async def query_longest_no_spend_streak_handler(entities, message):
    persons = entities.get("persons")
    if not persons:
        await message.channel.send("❌ Could not determine person(s) to query.")
        return

    result = await su.longest_no_spend_streak(persons)
    if result is None:
        await message.channel.send("💸 No no-spend streaks found this month.")
        return

    length, start_day, end_day = result
    today = datetime.today()
    month_year = today.strftime("%B %Y")
    response = (
        f"🚫 Longest no-spend streak: {length} days "
        f"({month_year} {start_day}–{end_day})"
    )

    await message.channel.send(response)


async def query_days_budget_lasts_handler(message):
    estimated_days = await su.days_budget_lasts()

    if estimated_days is None:
        await message.channel.send(
            "❌ Could not calculate how long your budget will last."
        )
        return

    await message.channel.send(
        f"📈 At your current pace, your budget will last ~{estimated_days} more days this month."
    )


async def query_most_frequent_purchases_handler(entities, message):
    n = int(entities.get("n", 3))
    persons = entities.get("persons")
    if not persons:
        await message.channel.send("❌ Could not determine person(s) to query.")
        return

    results = await su.most_frequent_purchases(persons, n)

    if not results:
        await message.channel.send("❌ Could not find any purchases this month.")
        return

    response_lines = [f"🔂 Top {n} most frequent purchases this month:"]
    for i, r in enumerate(results, 1):
        response_lines.append(
            f"{i}. {r['item'].capitalize()} — {r['count']} times (${r['total']:.2f} total)"
        )

    response = "\n".join(response_lines)

    await message.channel.send(response)


async def query_expenses_on_day_handler(entities, message):
    day_str = entities.get("date")
    persons = entities.get("persons")

    if not persons:
        await message.channel.send("❌ Could not determine person(s) to query.")
        return

    # Try fallback if no date extracted
    if not day_str:
        # naive fallback: extract number from message
        import re
        m = re.search(r"\b(\d{1,2})(st|nd|rd|th)?\b", message.content)
        if m:
            day_str = m.group(1)  # just the number
            # prepend month/year
            today = get_local_today()
            day_str = f"{today.month}/{int(day_str)}/{today.year}"
            print(f"[INFO] Fallback parsed date: {day_str}")
        else:
            await message.channel.send("❌ Please specify a date (e.g., MM/DD, MM/DD/YYYY, or YYYY-MM-DD).")
            return

    entries, total = await su.expenses_on_day(day_str, persons)

    if not entries:
        await message.channel.send(f"📆 No expenses found on {day_str}.")
        return

    # sort entries by amount (descending)
    entries.sort(key=lambda e: e["amount"], reverse=True)

    response_lines = [f"📆 Expenses on {day_str} (total ${total:.2f}):"]
    for e in entries:
        response_lines.append(
            f"- ${e['amount']:.2f} — {e['item']} @ {e['location']} ({e['category']})"
        )

    response = "\n".join(response_lines)
    await message.channel.send(response)


async def query_subscriptions_handler(message):
    needs, needs_total, wants, wants_total = await su.list_subscriptions()

    if not needs and not wants:
        await message.channel.send("❌ No subscriptions found.")
        return

    response_lines = []

    if needs:
        response_lines.append(f"📌 **Needs Subscriptions** (total: ${needs_total:.2f}):")
        for name, amt in needs:
            response_lines.append(f"- {name}: ${amt:.2f}")
        response_lines.append("")

    if wants:
        response_lines.append(f"📌 **Wants Subscriptions** (total: ${wants_total:.2f}):")
        for name, amt in wants:
            response_lines.append(f"- {name}: ${amt:.2f}")

    response = "\n".join(response_lines)
    await message.channel.send(response)


async def log_rent_paid_handler(entities, message):
    amount = entities.get("amount")
    if amount is None:
        await message.channel.send("❌ Please specify the amount you paid for rent.")
        return

    success = su.log_rent_paid(amount)
    if success:
        await message.channel.send(f"✅ Logged rent as paid: ${amount:.2f}")
    else:
        await message.channel.send("❌ Could not find the Rent row to log payment.")


async def log_smud_paid_handler(entities, message):
    amount = entities.get("amount")
    if amount is None:
        await message.channel.send("❌ Please specify the amount you paid for SMUD.")
        return

    success = su.log_smud_paid(amount)
    if success:
        await message.channel.send(f"✅ Logged SMUD as paid: ${amount:.2f}")
    else:
        await message.channel.send("❌ Could not find the SMUD row to log payment.")


async def log_student_loan_paid_handler(entities, message):
    amount = entities.get("amount")
    if amount is None:
        await message.channel.send("❌ Please specify the amount you paid for your student loan.")
        return

    success = su.log_student_loan_paid(amount)
    if success:
        await message.channel.send(f"✅ Logged student loan as paid: ${amount:.2f}")
    else:
        await message.channel.send("❌ Could not find the Student Loan row to log payment.")


async def query_1st_savings_handler(entities, message):
    result = await su.check_1st_savings_deposited()
    if result["deposited"]:
        response = (
            f"✅ 1st savings deposited: ${result['actual']:.2f}\n"
            f"💡 Ideal: ${result['ideal']:.2f} | Minimum: ${result['minimum']:.2f}"
        )
    else:
        response = (
            f"❌ 1st savings not deposited.\n"
            f"💡 Ideal: ${result['ideal']:.2f} | Minimum: ${result['minimum']:.2f}"
        )
    await message.channel.send(response)


async def query_2nd_savings_handler(entities, message):
    result = await su.check_2nd_savings_deposited()
    if result["deposited"]:
        response = (
            f"✅ 2nd savings deposited: ${result['actual']:.2f}\n"
            f"💡 Ideal: ${result['ideal']:.2f} | Minimum: ${result['minimum']:.2f}"
        )
    else:
        response = (
            f"❌ 2nd savings not deposited.\n"
            f"💡 Ideal: ${result['ideal']:.2f} | Minimum: ${result['minimum']:.2f}"
        )
    await message.channel.send(response)


async def log_1st_savings_handler(entities, message):
    amount = entities.get("amount")
    if amount is None:
        await message.channel.send("❌ Please specify the amount for 1st savings.")
        return
    success = su.log_1st_savings(amount)
    if success:
        await message.channel.send(f"✅ Logged 1st savings: ${amount:.2f}")
    else:
        await message.channel.send("❌ Failed to log 1st savings.")


async def log_2nd_savings_handler(entities, message):
    amount = entities.get("amount")
    if amount is None:
        await message.channel.send("❌ Please specify the amount for 2nd savings.")
        return
    success = su.log_2nd_savings(amount)
    if success:
        await message.channel.send(f"✅ Logged 2nd savings: ${amount:.2f}")
    else:
        await message.channel.send("❌ Failed to log 2nd savings.")


async def log_need_expense_handler(entities, message):
    description = entities.get("description")
    amount = entities.get("amount")
    if not description or amount is None:
        await message.channel.send("❌ Please specify both a description and an amount for the Need expense.")
        return
    success = su.log_need_expense(description, amount)
    if success:
        await message.channel.send(f"✅ Logged Need expense: '{description}' - ${amount:.2f}")
    else:
        await message.channel.send("❌ Failed to log Need expense.")
