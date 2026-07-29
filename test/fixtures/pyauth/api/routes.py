from fastapi import APIRouter

from .gatekeeping import LockedRouter, Tenant, Whoever

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
