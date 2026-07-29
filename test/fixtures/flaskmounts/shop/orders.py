from flask import Blueprint

# Flask spells it `url_prefix`, and puts it on the blueprint rather than the mount.
orders = Blueprint("orders", __name__, url_prefix="/orders")


@orders.route("/<order_id>", methods=["GET"])
def read_order(order_id):
    return {"id": order_id}
