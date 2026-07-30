from fastapi import APIRouter

router = APIRouter(prefix="/items")


@router.get("/")
def list_items():
    """Its own file calls this `/`. Two files away it is `/api/v2/items/`."""
    return []


@router.get("/{item_id}")
def read_item(item_id: str):
    return {"id": item_id}
