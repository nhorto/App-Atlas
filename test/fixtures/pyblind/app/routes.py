"""Routes whose check lives in a file we could not read.

Nothing here names a check. The lock is the `CurrentUser` annotation, and what makes
it a lock is a `Depends` two files away, in the one file that would not parse.
"""
from fastapi import APIRouter

from app.deps import CurrentUser

router = APIRouter()


@router.get("/items")
def list_items(user: CurrentUser) -> list[str]:
    return ["one", "two"]


@router.post("/items")
def create_item(name: str, user: CurrentUser) -> dict:
    return {"name": name}
