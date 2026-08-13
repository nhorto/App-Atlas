"""The base every locked page in this app inherits from.

Nothing here is written on the views the URLconf names, and nothing in the URLconf
mentions this file. The chain from one to the other runs through `bases` and only
through `bases` — see `LoginPage` in `views.py` for what happens when it runs through
anything looser.
"""

from django.contrib.auth.mixins import LoginRequiredMixin
from django.views.generic import View


class SecureView(LoginRequiredMixin, View):
    login_url = "/accounts/login/"
