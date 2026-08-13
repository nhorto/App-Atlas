"""The root URLconf, written the way a deployable Django app writes one.

The sub-path prefix is a name with two assignments, which is the idiom for "serve me at
`/` unless someone configures otherwise". It is deliberately unreadable: the point of
the fixture is that an unreadable prefix must not put an ellipsis in front of every
address in the app.
"""

from __future__ import annotations

import os

from django.urls import include, path

from front import views as front_views

prefix = ""
if os.environ.get("SITE_PATH"):
    prefix = os.environ["SITE_PATH"] + "/"

urlpatterns = [
    path(prefix, include("api.urls")),
    path(prefix, include("front.urls")),
    path("healthz/", front_views.healthz),
]
