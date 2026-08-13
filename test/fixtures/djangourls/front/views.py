"""Views whose protection is written as a decorator, the way Django writes it."""

from __future__ import annotations

from django.contrib.auth.decorators import login_required
from django.http import HttpRequest, HttpResponse


def index(request: HttpRequest) -> HttpResponse:
    """The public landing page. Open on purpose."""
    return HttpResponse("hello")


def healthz(request: HttpRequest) -> HttpResponse:
    """A liveness probe. Open on purpose."""
    return HttpResponse("ok")


@login_required
def update_name(request: HttpRequest) -> HttpResponse:
    """Renames a check. Behind a session."""
    return HttpResponse("renamed")
