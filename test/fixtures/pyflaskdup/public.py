from flask import Blueprint

from .helpers import make_rule

public_bp = Blueprint("public", __name__, url_prefix="/public")


@public_bp.route(make_rule("/list"))
def public_list():
    return {"items": ["hats", "scarves"]}
