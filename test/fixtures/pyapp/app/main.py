"""The public API for the sample app.

Two of these routes check who is calling and two do not, which is the whole point
of the fixture.
"""

from fastapi import Depends, FastAPI, Request

from .db import Order, User, get_session, list_users, save_order
from .services.billing import charge_customer

app = FastAPI()


@app.get("/users")
async def read_users(limit: int = 20, session=Depends(get_session)) -> list[User]:
    """Everyone who has signed up."""
    return list_users(session, limit)


@app.post("/orders")
async def create_order(amount: int, user=Depends(get_current_user), session=Depends(get_session)):
    """Takes money and records the order."""
    order = Order()
    save_order(session, order)
    return charge_customer(amount)


@app.get("/health")
def health():
    return {"ok": True}


@app.post("/webhooks/stripe")
async def stripe_webhook(request: Request):
    """Stripe tells us a payment settled."""
    return {"received": True}


def get_current_user():
    """Resolves the signed-in user, or raises."""
    return None
