import os

from fastapi import APIRouter, FastAPI

from .api import api_router
from .config import settings

app = FastAPI()

# The whole API sits behind a prefix written as a name, two files from any route.
app.include_router(api_router, prefix=settings.API_PREFIX)

# A router mounted straight onto the app with a literal — the short chain.
health = APIRouter(prefix="/health")


@health.get("/live")
def live():
    return {"ok": True}


app.include_router(health)

# And one whose prefix cannot be read at all. The route below it keeps its own path and
# says, in the address itself, that something in front of it is missing.
guessing = APIRouter()


@guessing.get("/anyone")
def anyone():
    return {}


app.include_router(guessing, prefix=os.environ["MOUNT_AT"])
