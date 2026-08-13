"""A requests-like interface for PycURL — the shape healthchecks uses.

This is the only file in the project that imports an HTTP library. Every call site
elsewhere says `curl.post(...)`, which on its own looks like a method on some local
object, and the boundary view used to report no outside services at all.
"""

from __future__ import annotations

from io import BytesIO
from typing import Any

import pycurl


class Response:
    def __init__(self, status: int, content: bytes) -> None:
        self.status_code = status
        self.content = content


def request(method: str, url: str, data: Any = None, headers: Any = None) -> Response:
    buffer = BytesIO()
    handle = pycurl.Curl()
    handle.setopt(pycurl.URL, url)
    handle.setopt(pycurl.CUSTOMREQUEST, method)
    handle.setopt(pycurl.WRITEDATA, buffer)
    handle.perform()
    status = handle.getinfo(pycurl.RESPONSE_CODE)
    handle.close()
    return Response(status, buffer.getvalue())


def get(url: str, **kwargs: Any) -> Response:
    return request("GET", url, **kwargs)


def post(url: str, data: Any = None, **kwargs: Any) -> Response:
    return request("POST", url, data=data, **kwargs)
