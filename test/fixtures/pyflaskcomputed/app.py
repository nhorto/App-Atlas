"""Routes whose address the source computes.

redash writes 23 of its 28 route decorators this way — `org_scoped_rule` prefixes the
tenant slug — and every one of them was invisible, because a first argument that is not
a string literal made the detector `continue` past the whole finding. The handler, the
methods and the guard went with it.

`login_required` on `session` is the point of the negative case: the check is real,
readable, and sitting one line below a decorator whose path cannot be resolved. Dropping
the door threw away a fact about auth that had nothing to do with the address.
"""

from flask import Blueprint
from flask_login import login_required

routes = Blueprint('routes', __name__)


def org_scoped_rule(rule):
    return '/<org_slug:org_slug>' + rule


@routes.route("/api/config", methods=["GET"])
def config():
    return {}


@routes.route(org_scoped_rule("/login"), methods=["GET", "POST"])
def login():
    return {}


@routes.route(org_scoped_rule("/api/session"), methods=["GET"])
@login_required
def session():
    return {}


@routes.route(org_scoped_rule("/logout"))
def logout():
    return {}
