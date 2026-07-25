"""Talking to the payment processor."""

import os

import httpx
import stripe

stripe.api_key = os.getenv("STRIPE_SECRET_KEY")


def charge_customer(amount_cents: int):
    """Charges a card and tells the ledger about it."""
    response = httpx.post("https://api.stripe.com/v1/charges", data={"amount": amount_cents})
    return response.json()


def notify_ledger(order_id: str) -> None:
    httpx.post("https://ledger.acme-books.com/orders", json={"id": order_id})
