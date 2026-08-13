from django.urls import path

from . import views
from .views import WidgetList

urlpatterns = [
    path("widgets/", views.WidgetList.as_view()),
    # The same class, named without the module it came from.
    path("widgets-bare/", WidgetList.as_view()),
    path("billing/", views.BillingView.as_view()),
    path("archive/", views.ArchiveView.as_view()),
    path("report/", views.ReportView.as_view()),
    path("gate/", views.GateView.as_view()),
    path("about/", views.MarketingPage.as_view()),
    path("login/", views.LoginPage.as_view()),
]
