"""Two doors with no mention of the lock in front of them.

Nothing in this file says a caller has to be signed in. The line that decides it is in
`api.py`, and a reader who only opened this file would come away believing the opposite.
"""

from fastapi import APIRouter

router = APIRouter()


@router.get("/items")
def list_items():
    """Everything the caller is allowed to see."""
    return []


@router.delete("/items/{item_id}")
def delete_item(item_id: int):
    """Throws one away."""
    return {"deleted": item_id}
