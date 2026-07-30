"""Outbound calls, some of which name where they are going and some of which do not."""

import requests

session = requests.Session()


def send_receipt(order_id: str) -> None:
    """A literal URL. This is a company, and we can say which one."""
    requests.post("https://api.postmarkapp.com/email", json={"order": order_id})


def fetch(url: str):
    """No literal URL anywhere. Where this goes is genuinely unknown."""
    return session.get(url)


def fetch_many(urls: list[str]) -> list:
    return [s.get(u) for u in urls for s in [session]]
