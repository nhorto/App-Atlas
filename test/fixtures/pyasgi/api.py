"""Where the lock is written: one line, standing in front of every private route."""

from fastapi import APIRouter, Depends

from auth import get_current_user
from private_views import router as private_router
from public_views import router as public_router

api_router = APIRouter()

api_router.include_router(public_router, prefix="/public")

# The whole of the authentication story for `private_views.py`.
api_router.include_router(
    private_router,
    prefix="/private",
    dependencies=[Depends(get_current_user)],
)
