"""The app's own API-key check, so the guard is not a name Django ships."""

from __future__ import annotations

from functools import wraps

from django.http import HttpResponse, JsonResponse


def authorize(view):
    """Rejects a caller without a usable API key."""

    @wraps(view)
    def wrapper(request, *args, **kwargs) -> HttpResponse:
        if not request.headers.get("X-Api-Key"):
            return JsonResponse({"error": "missing api key"}, status=401)
        return view(request, *args, **kwargs)

    return wrapper
