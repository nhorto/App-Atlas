"""The three ways a real notifier writes down where it is sending something.

None of them puts a library and an address on the same line, which is why all three
used to come out blank.
"""

from __future__ import annotations

from typing import Any

from lib import curl


class Transport:
    @classmethod
    def post(cls, url: str, **kwargs: Any) -> curl.Response:
        """Every subclass sends through here, four layers above the actual client."""
        return curl.request("POST", url, **kwargs)


class PushoverTransport(Transport):
    # The address is a class constant, and the call below hands it to `self.post`.
    URL = "https://api.pushover.net/1/messages.json"

    def notify(self, message: str) -> None:
        self.post(self.URL, data={"message": message})


class TelegramTransport(Transport):
    # An f-string that gets a whole hostname out before its first placeholder.
    SEND = "https://api.telegram.org/bot{}/sendMessage".format("TOKEN")
    SEND_F = f"https://api.telegram.org/bot{'TOKEN'}/sendMessage"

    def notify(self, message: str) -> None:
        self.post(self.SEND_F, data={"text": message})


class OpsgenieTransport(Transport):
    def notify(self, message: str) -> None:
        # A plain local variable on the line above the request, with a conditional
        # override after it. The first one is the deployment nobody configured.
        url = "https://api.opsgenie.com/v2/alerts"
        if message.startswith("eu:"):
            url = "https://api.eu.opsgenie.com/v2/alerts"
        self.post(url, data={"message": message})


class TwilioTransport(Transport):
    URL = "https://api.twilio.com/2010-04-01/Accounts/%s/Messages.json"

    def notify(self, message: str) -> None:
        url = self.URL % "ACCOUNT_SID"
        self.post(url, data={"Body": message})


def exchange_oauth_code(code: str) -> curl.Response:
    """The other shape: the wrapper called straight, with the address written out."""
    return curl.post("https://slack.com/api/oauth.v2.access", data={"code": code})
