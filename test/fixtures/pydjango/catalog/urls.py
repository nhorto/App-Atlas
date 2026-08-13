"""The routing table, written the way Django writes one.

Nothing in this file imports Flask, FastAPI, Quart or Sanic — which is the entire
point of the fixture. For two releases the Django reader sat below a gate that
returned unless one of those four was imported, so it never ran on a real Django
project and every test stayed green (#139).
"""

from django.contrib.auth import views as auth_views
from django.urls import include, path, re_path

from . import views

app_name = 'catalog'

urlpatterns = [
    path('widgets/', views.widget_list),
    path('widgets/<int:pk>/', views.widget_detail),
    re_path(r'^legacy/widgets/$', views.widget_list),
    # A view from a package rather than from this repo. There is no file here to open,
    # so whatever guards it cannot be read — and the door has to say so rather than be
    # counted as one nobody checks.
    path('signin/', auth_views.login_view),
    # A prefix, not an endpoint: this mounts another URLconf. Counting it would put a
    # door on the map at an address nothing answers.
    path('api/', include('catalog.api.urls')),
]
