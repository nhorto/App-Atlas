"""Deliberately unhelpful names.

Nothing here is called `get_current_user` or `require_auth`, so a detector that works
off a vocabulary list finds nothing. What makes `who_is_asking` a check is that it
turns strangers away with a 401 — which is a fact about the code, not about the name.
"""

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status


class Caller:
    id: str


def who_is_asking(token: str = "") -> Caller:
    if not token:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="no token")
    return Caller()


def fetch_tenant(slug: str = "") -> str:
    """Not a check. Fetching a thing is not the same as refusing a stranger."""
    return slug


# The name a route's signature will actually say.
Whoever = Annotated[Caller, Depends(who_is_asking)]
Tenant = Annotated[str, Depends(fetch_tenant)]


class LockedRouter(APIRouter):
    """Every route registered on one of these is behind the check."""

    def __init__(self, prefix: str = "", **kwargs):
        super().__init__(prefix=prefix, dependencies=[Depends(who_is_asking)], **kwargs)
