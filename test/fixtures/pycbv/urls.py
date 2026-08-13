from django.urls import include, path

urlpatterns = [
    path("app/", include("dashboard.urls")),
    path("api/", include("api.urls")),
]
