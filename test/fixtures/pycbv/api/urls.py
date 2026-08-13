from django.urls import path

from .views import DocumentViewSet, NoteViewSet, QuietViewSet, StatusAPI, VersionView

urlpatterns = [
    path("docs/", DocumentViewSet.as_view({"get": "list"})),
    path("quiet/", QuietViewSet.as_view({"get": "list"})),
    path("notes/", NoteViewSet.as_view({"get": "list"})),
    path("status/", StatusAPI.as_view()),
]

urlpatterns += [path("version/", VersionView.as_view())]
