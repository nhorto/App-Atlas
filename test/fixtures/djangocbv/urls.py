"""Every view imported by name, and mounted with `as_view()`."""

from django.urls import path

from app.views import BulkView
from app.views import OwnView
from app.views import PublicView
from app.views import StatsView

urlpatterns = [
    path("bulk/", BulkView.as_view(), name="bulk"),
    path("own/", OwnView.as_view(), name="own"),
    path("public/", PublicView.as_view(), name="public"),
    path("stats/", StatsView.as_view(), name="stats"),
]
