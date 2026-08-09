"""The classes the routing table names. Each one is a full REST surface."""

from rest_framework import viewsets
from rest_framework.permissions import IsAuthenticated


class DocumentViewSet(viewsets.ModelViewSet):
    permission_classes = [IsAuthenticated]


class TagViewSet(viewsets.ModelViewSet):
    permission_classes = [IsAuthenticated]


class StatusViewSet(viewsets.ReadOnlyModelViewSet):
    """Deliberately read-only — one reason not to invent list/create/destroy doors."""
