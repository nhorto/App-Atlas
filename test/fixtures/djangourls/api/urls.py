"""One list of routes, mounted twice — the versioned-API shape.

Nothing in `api_urls` mentions a version. Read flat, `checks/` is the address, and it is
not one this app answers at.
"""

from __future__ import annotations

from django.urls import include, path, re_path

from api import views

api_urls = [
    path("checks/", views.checks),
    path("checks/<uuid:code>", views.single),
]

urlpatterns = [
    path("api/v1/", include(api_urls)),
    path("api/v2/", include(api_urls)),
]

# paperless-ngx's shape: the whole tree written as nested list literals inside the
# `include()` calls themselves, so not one level has a name to be mounted under. And
# `re_path` prefixes, whose `^` is regex punctuation rather than part of the address.
urlpatterns += [
    re_path(
        r"^admin/",
        include(
            [
                re_path("^audit/", views.audit),
                re_path(
                    "^tokens/",
                    # Django's two-tuple form: the routes, and the app they belong to.
                    include(([path("rotate/", views.rotate)], "tokens"), namespace="tokens"),
                ),
            ],
        ),
    ),
]
