"""The views the routing table names.

`widget_detail` is locked and `widget_list` is not, and the only record of either is
this file — `urls.py` names the views and says nothing about what stands in front of
them. Following that link is item 40/44's work; before it, every Django door in every
repo read "not examined".
"""

from django.contrib.auth.decorators import login_required


def widget_list(request):
    return None


@login_required
def widget_detail(request, pk):
    return None
