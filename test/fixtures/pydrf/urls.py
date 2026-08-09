"""paperless-ngx's shape (#170): the registration table IS the API."""

from django.urls import path
from rest_framework.routers import DefaultRouter

from .views import landing
from .viewsets import DocumentViewSet, StatusViewSet, TagViewSet

api_router = DefaultRouter()
api_router.register(r"documents", DocumentViewSet)
api_router.register(r"tags", TagViewSet)
api_router.register(r"status", StatusViewSet, basename="status")

urlpatterns = [
    path("about/", landing),
    *api_router.urls,
]
