"""The URLconf shape `paperless-ngx` is built from: nothing but inline lists.

`include()` is handed a list literal rather than a module string or a named variable, and
the lists nest four deep. There is no name anywhere for a mount to resolve against, which
is why every address underneath used to be read flat — without `api/`, and without the
section it sits in.
"""

from django.urls import include
from django.urls import path
from django.urls import re_path

from app import views

urlpatterns = [
    re_path(
        r"^api/",
        include(
            [
                # A namespaced include: the patterns are the first element of a tuple,
                # which is how Django's own documentation spells an app namespace.
                re_path(
                    "^auth/",
                    include(
                        (
                            [
                                path("login/", views.api_login, name="login"),
                                path("logout/", views.api_logout, name="logout"),
                            ],
                            "rest_framework",
                        ),
                        namespace="rest_framework",
                    ),
                ),
                re_path(
                    "^documents/",
                    include(
                        [
                            re_path(
                                "^post_document/",
                                views.post_document,
                                name="post_document",
                            ),
                            re_path("^bulk_edit/", views.bulk_edit, name="bulk_edit"),
                        ],
                    ),
                ),
                re_path("^statistics/$", views.statistics, name="statistics"),
            ],
        ),
    ),
    path(
        "accounts/",
        include(
            [
                # The same last segment as the one under `api/auth/` above. Read flat,
                # both are `/login/` and the two doors merge into one — which pools their
                # checks, and is how a private door borrows a public one's silence.
                path("login/", views.account_login, name="account_login"),
            ],
        ),
    ),
    # The spelling that already worked, kept here so it keeps working.
    path("legacy/", include("app.urls")),
]
