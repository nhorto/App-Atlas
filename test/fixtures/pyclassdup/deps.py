"""The check both files could name, and only one does."""

from fastapi import Header, HTTPException


def who_is_asking(authorization: str = Header(None)):
    if not authorization:
        raise HTTPException(status_code=401, detail="who is this")
    return authorization
