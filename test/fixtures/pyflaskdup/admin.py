from flask import Blueprint
from flask_login import login_required

from .helpers import make_rule

admin_bp = Blueprint("admin", __name__, url_prefix="/admin")


@admin_bp.route(make_rule("/list"))
@login_required
def admin_list():
    return {"users": ["everything"]}
