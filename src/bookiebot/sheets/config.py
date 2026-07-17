# sheets_config.py

get_category_columns = {
    "grocery": {
        "start_row": 3,
        "columns": {
            "date": "A",
            "amount": "B",
            "location": "C",
            "person": "D"
        }
    },
    "gas": {
        "start_row": 3,
        "columns": {
            "date": "H",
            "amount": "I",
            "person": "J"
        }
    },
    "food": {
        "start_row": 3,
        "columns": {
            "date": "N",
            "item": "O",
            "amount": "P",
            "location": "Q",
            "person": "R"
        }
    },
    "shopping": {
        "start_row": 3,
        "columns": {
            "date": "V",
            "item": "W",
            "amount": "X",
            "location": "Y",
            "person": "Z"
        }
    },
    "need_expenses": {
        "start_row": 3,
        "columns": {
            "date": "AD",
            "item": "AE",
            "amount": "AF",
            "location": "AG",
            "person": "AH"
        }
    }
}


_CATEGORY_ALIASES = {
    "groceries": "grocery",
    "need": "need_expenses",
    "needs": "need_expenses",
    "need_expense": "need_expenses",
    "needs_expense": "need_expenses",
    "need_expenses": "need_expenses",
    "needs_expenses": "need_expenses",
}


def normalize_expense_category(value: object) -> str:
    category = str(value or "").strip().lower().replace("-", "_").replace(" ", "_")
    return _CATEGORY_ALIASES.get(category, category)


def expense_category_label(value: object) -> str:
    category = normalize_expense_category(value)
    if category == "need_expenses":
        return "Needs"
    return category.replace("_", " ").title()
