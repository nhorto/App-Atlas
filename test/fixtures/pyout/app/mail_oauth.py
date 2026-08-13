"""OAuth clients whose *module path* is the only place the company is named (#178).

`paperless-ngx` reaches Gmail and Outlook through exactly these two imports, and they
are the only mention of either company in 748 files: the mail server itself comes from
the user's own account settings, so there is no hostname literal anywhere to read.
Reduced to a top-level import name they are both `httpx_oauth`, which is a library and
not a company anybody sends data to.
"""

from httpx_oauth.clients.google import GoogleOAuth2
from httpx_oauth.clients.microsoft import MicrosoftGraphOAuth2


def gmail_client(client_id: str, secret: str) -> GoogleOAuth2:
    return GoogleOAuth2(client_id, secret)


def outlook_client(client_id: str, secret: str) -> MicrosoftGraphOAuth2:
    return MicrosoftGraphOAuth2(client_id, secret)
