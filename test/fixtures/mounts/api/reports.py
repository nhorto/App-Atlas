from fastapi import APIRouter

router = APIRouter()


@router.get("/monthly")
def monthly():
    """Mounted twice, under two different prefixes."""
    return []
