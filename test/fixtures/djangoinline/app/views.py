"""Handlers for the inline URLconf."""

from django.contrib.auth.decorators import login_required
from django.http import JsonResponse


def api_login(request):
    return JsonResponse({"ok": True})


def api_logout(request):
    return JsonResponse({"ok": True})


def account_login(request):
    return JsonResponse({"ok": True})


@login_required
def post_document(request):
    return JsonResponse({"queued": True})


@login_required
def bulk_edit(request):
    return JsonResponse({"edited": 0})


def statistics(request):
    return JsonResponse({"documents": 0})


def legacy(request):
    return JsonResponse({"legacy": True})
