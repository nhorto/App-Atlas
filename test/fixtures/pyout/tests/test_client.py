"""Fixtures, not customers. Nothing here is a company this app sends data to."""

import requests

from app.client import send_receipt


def test_send_receipt():
    requests.post("https://httpbin.org/post", json={"order": "1"})
    send_receipt("1")


def test_fetch():
    requests.get("https://example.org/health")
