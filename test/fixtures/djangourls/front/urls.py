"""A nested list: `include()` handed a local variable rather than a module name.

`path("name/", views.update_name)` answers at `/checks/<uuid:code>/name/`, and the only
record of the two segments in front of it is the `include(check_urls)` below.
"""

from __future__ import annotations

from django.urls import include, path

from front import views

check_urls = [
    path("name/", views.update_name),
]

urlpatterns = [
    path("", views.index),
    path("checks/<uuid:code>/", include(check_urls)),
]
