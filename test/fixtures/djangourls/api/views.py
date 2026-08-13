"""API views. The key check is a decorator the API defines for itself."""

from __future__ import annotations

from django.http import HttpRequest, HttpResponse, JsonResponse

from api.auth import authorize


@authorize
def checks(request: HttpRequest) -> HttpResponse:
    """Lists the caller's checks. Behind an API key."""
    return JsonResponse({"checks": []})


@authorize
def single(request: HttpRequest, code: str) -> HttpResponse:
    """One check. Behind an API key."""
    return JsonResponse({"code": code})
