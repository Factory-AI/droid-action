"""A synthetic report with no real users, money, network, or credentials."""

import json

from .authorization import can_view_export
from .cart import subtotal_cents
from .pagination import page


def example_report():
    return {
        "subtotal_cents": subtotal_cents(
            [{"unit_cents": 500, "quantity": 3}]
        ),
        "first_page": page(["A", "B", "C"], 0, 2),
        "member_can_view": can_view_export(
            actor_id="demo-member", role="member", owner_id="demo-owner"
        ),
    }


if __name__ == "__main__":
    print(json.dumps(example_report(), sort_keys=True))
