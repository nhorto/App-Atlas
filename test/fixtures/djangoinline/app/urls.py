"""A module-string include, the spelling that already composed."""

from django.urls import path

from app import views

urlpatterns = [
    path("old/", views.legacy, name="legacy"),
]
