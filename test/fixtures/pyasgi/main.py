"""The app, the middleware on it, and a second app mounted inside it."""

from fastapi import FastAPI, Request
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.middleware.gzip import GZipMiddleware
from starlette.responses import JSONResponse

from admin_views import router as admin_router
from api import api_router


class AuthMiddleware(BaseHTTPMiddleware):
    """Turns strangers away before any handler runs."""

    async def dispatch(self, request: Request, call_next):
        if not request.headers.get("authorization"):
            return JSONResponse(status_code=401, content={"detail": "Not authenticated"})
        return await call_next(request)


app = FastAPI()
# Middleware, and not a check. Both are attached the same way.
app.add_middleware(GZipMiddleware, minimum_size=1000)
app.include_router(api_router)

admin = FastAPI()
admin.add_middleware(AuthMiddleware)
admin.include_router(admin_router)

app.mount("/admin", app=admin)
