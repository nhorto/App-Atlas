"""DRF, where the lock is a class attribute and the default is in settings."""

from typing import Any

from rest_framework.generics import GenericAPIView
from rest_framework.permissions import AllowAny, IsAuthenticated, IsAuthenticatedOrReadOnly
from rest_framework.views import APIView
from rest_framework.viewsets import ModelViewSet


class DocumentViewSet(ModelViewSet):
    permission_classes = [IsAuthenticated]


class QuietViewSet(ModelViewSet):
    """Names no permission. DEFAULT_PERMISSION_CLASSES decides, wherever that is."""


class NoteViewSet(ModelViewSet):
    """Locked for writes, open for reads — and no method here says which this is."""

    permission_classes = [IsAuthenticatedOrReadOnly]


class StatusAPI(APIView):
    permission_classes = [AllowAny]


class VersionView(GenericAPIView[Any]):
    """A DRF base written with a type parameter, which is how paperless-ngx writes
    every one of them. With the subscript left on the name, this read as a plain class
    with no check on it — and was reported open."""
