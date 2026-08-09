"""The other ApiController: same name, different file, no check — on purpose."""

from fastapi import APIRouter

public = APIRouter()


class ApiController:
    @public.get("/public/status")
    def status(self):
        return {"ok": True}
