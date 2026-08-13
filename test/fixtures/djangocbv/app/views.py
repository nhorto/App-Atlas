"""Class-based views, which declare their checks rather than wearing them."""

from django.contrib.auth.mixins import LoginRequiredMixin
from django.views.generic import TemplateView
from rest_framework.permissions import AllowAny
from rest_framework.permissions import IsAuthenticated
from rest_framework.views import APIView


class PermissionMixin(APIView):
    """The shape paperless uses: the policy lives one level up."""

    permission_classes = (IsAuthenticated,)


class BulkView(PermissionMixin):
    """Declares nothing itself. Its only check is inherited."""

    def post(self, request):
        return None


class OwnView(APIView):
    permission_classes = (IsAuthenticated,)

    def get(self, request):
        return None


class PublicView(APIView):
    """A door held open on purpose, which is a fact and not a lock."""

    permission_classes = (AllowAny,)

    def get(self, request):
        return None


class StatsView(LoginRequiredMixin, TemplateView):
    template_name = "stats.html"
