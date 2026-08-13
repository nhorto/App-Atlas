"""Django's four spellings of a lock on a class, and two doors with none."""

from django.contrib.auth.decorators import login_required
from django.contrib.auth.mixins import LoginRequiredMixin
from django.http import HttpResponseForbidden
from django.utils.decorators import method_decorator
from django.views.generic import ListView, TemplateView, View

from .base import RemoteSecureView


class SecureView(LoginRequiredMixin, View):
    """The base every locked page in this app inherits from."""

    login_url = "/accounts/login/"


class WidgetList(LoginRequiredMixin, ListView):
    """A mixin in the bases: `@login_required` written for a class."""

    template_name = "widgets.html"


class BillingView(SecureView):
    """Says nothing, inherits everything. The lock is on the class above."""

    template_name = "billing.html"


class ArchiveView(RemoteSecureView):
    """Inherits from a base in *another* file, which this reader does not follow.

    A class and its view mixins usually live together and here is where the reader
    looks. Following a base across files would mean trusting a name, and two apps in
    one repo naming a class `Base` is ordinary — so this door under-claims rather than
    borrow a lock that may belong to somebody else's class.
    """

    template_name = "archive.html"


@method_decorator(login_required, name="dispatch")
class ReportView(View):
    def get(self, request):
        return None


class GateView(View):
    """Its own front door, the way plenty of real views are written."""

    def dispatch(self, request, *args, **kwargs):
        if not request.user.is_authenticated:
            return HttpResponseForbidden()
        return super().dispatch(request, *args, **kwargs)


class MarketingPage(TemplateView):
    template_name = "marketing.html"


class LoginPage(TemplateView):
    """Open by design, and it names a locked view — which is the whole trap (#147).

    A reference edge between two classes means "mentions". Let a class-level check
    travel along one and this page, the front door of the product, is reported locked.
    """

    template_name = "login.html"

    def next_url(self):
        return BillingView.success_url
