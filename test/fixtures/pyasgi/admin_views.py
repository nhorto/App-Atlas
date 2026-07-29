"""One door behind a middleware, which this file cannot see either."""

from fastapi import APIRouter

router = APIRouter()


@router.get("/settings")
def read_settings():
    """What the service is configured to do."""
    return {}
