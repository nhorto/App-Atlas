from fastapi import APIRouter

router = APIRouter(prefix="/users")


@router.get("/")
def list_users():
    """Character for character the same decorator as the one in `items.py`.

    Before the prefixes were composed, both doors were called `GET /` — one key, one
    node, and a repo-wide undercount nobody would ever notice.
    """
    return []


@router.get("/{user_id}")
def read_user(user_id: str):
    return {"id": user_id}
