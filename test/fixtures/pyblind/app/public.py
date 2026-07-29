"""A route that imports nothing we failed to read. Genuinely unchecked."""
from fastapi import APIRouter

router = APIRouter()


@router.get("/health")
def health() -> dict:
    return {"ok": True}
