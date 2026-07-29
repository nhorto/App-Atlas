from flask import Flask

from shop.orders import orders

app = Flask(__name__)

# The blueprint already carries `/orders`; the registration adds the rest.
app.register_blueprint(orders, url_prefix="/api/orders")


@app.route("/healthz")
def healthz():
    """Straight on the app. Nothing in front of it, and nothing invented."""
    return {"ok": True}
