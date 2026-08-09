"""The guarded ApiController. Its namesake in public.py declares nothing — and if that
silence makes this one look like the only ApiController in the repo, this lock walks
onto the other file's door (#162)."""

from fastapi import APIRouter, Depends

from .deps import who_is_asking

internal = APIRouter()


class ApiController:
    caller = Depends(who_is_asking)

    @internal.get("/internal/reports")
    def reports(self):
        return []
