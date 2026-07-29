"""Two doors that are open on purpose."""

from fastapi import APIRouter

router = APIRouter()


@router.get("/health")
def health():
    """Says the service is up, to anyone who asks."""
    return {"status": "ok"}


@router.post("/login")
def login():
    """Hands out a token, so it cannot ask for one first."""
    return {"token": "..."}
