"""One list of routes, mounted twice — the versioned-API shape.

Nothing in `api_urls` mentions a version. Read flat, `checks/` is the address, and it is
not one this app answers at.
"""

from __future__ import annotations

from django.urls import include, path

from api import views

api_urls = [
    path("checks/", views.checks),
    path("checks/<uuid:code>", views.single),
]

urlpatterns = [
    path("api/v1/", include(api_urls)),
    path("api/v2/", include(api_urls)),
]
