"""The views the routing table names.

`login_required` is here so the fixture keeps a record of what is *not* yet claimed:
the guard is real and visible in this file, but nothing follows `views.widget_detail`
back from `urls.py` to find it. Until something does, neither route may be reported
as checked or as unchecked.
"""

from django.contrib.auth.decorators import login_required


def widget_list(request):
    return None


@login_required
def widget_detail(request, pk):
    return None
