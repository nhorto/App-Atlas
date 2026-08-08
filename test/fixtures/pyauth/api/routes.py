from fastapi import APIRouter, Depends

from .gatekeeping import LockedRouter, Tenant, Whoever, fetch_tenant, who_is_asking

router = APIRouter()
locked = LockedRouter(prefix="/admin")


@router.get("/status")
def status_check():
    """No dependency at all. This one really is open."""
    return {"ok": True}


@router.get("/profile")
def read_profile(caller: Whoever):
    """The lock is the annotation, and the annotation is defined in another file."""
    return {"id": caller.id}


@router.get("/tenant")
def read_tenant(tenant: Tenant):
    """A dependency that fetches rather than checks. Not a lock."""
    return {"tenant": tenant}


@locked.post("/purge")
def purge():
    """No annotation, no decorator. The router it hangs off is the whole check."""
    return {"purged": True}


@router.get("/summaries", dependencies=[Depends(who_is_asking)])
def read_summaries():
    """The lock is on the decorator, and the handler wants nothing from it (#136).

    This is how FastAPI's own template guards every administrator-only route, and the
    signature has nothing in it to find — so before #136 the only place the check was
    written down was read by nothing.
    """
    return {"reports": []}


@router.get(
    "/exports",
    dependencies=[Depends(who_is_asking)],
    response_model=None,
)
def read_exports():
    """The same, wrapped across lines the way a formatter leaves it."""
    return {"exports": []}


@router.get("/pings", dependencies=[Depends(fetch_tenant)])
def read_pings():
    """A decorator dependency that fetches rather than checks. Still not a lock."""
    return {"pings": []}
