def subtotal_cents(items):
    """Each item has positive quantity and nonnegative unit_cents."""
    return sum(item["unit_cents"] for item in items)
