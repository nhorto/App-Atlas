from fastapi import APIRouter

from . import items, reports, users

api_router = APIRouter()

api_router.include_router(items.router)
api_router.include_router(users.router)

# The same router hung in two places. Both addresses are real, so naming one of them
# would be picking a favourite and calling it the truth.
api_router.include_router(reports.router, prefix="/reports")
api_router.include_router(reports.router, prefix="/exports")
