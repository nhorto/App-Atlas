"""The one check the whole service is built on."""

from fastapi import HTTPException, Request


def get_current_user(request: Request):
    """Whoever is calling, or a 401."""
    token = request.headers.get("authorization")
    if not token:
        raise HTTPException(status_code=401, detail="Not authenticated")
    return token
