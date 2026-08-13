"""A base in a file of its own — the case this reader deliberately does not follow.

`inheritanceChain` reads bases within one file, which is where a project keeps a view
and its view mixins. Reaching further would mean resolving a bare class name across a
whole repo, and two apps each with a `Base` is ordinary; a lock attributed to the wrong
one of those is the expensive direction. So `ArchiveView` in `views.py` comes out blank.
"""

from django.contrib.auth.mixins import LoginRequiredMixin
from django.views.generic import View


class RemoteSecureView(LoginRequiredMixin, View):
    login_url = "/accounts/login/"
