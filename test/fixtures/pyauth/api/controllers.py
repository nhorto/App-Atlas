"""The class-based view: the lock is three classes up, in a file the handler never opens.

Both controllers below declare their routes the same way, in the same file, with the
same amount of auth vocabulary in them — none. What separates them is a base class two
links up the chain, which is the only place either answer is written down.
"""

from fastapi import APIRouter, Depends

from .gatekeeping import fetch_tenant, who_is_asking

reports = APIRouter()
public = APIRouter()


class _Controller:
    """Shared plumbing. A dependency, but not a check — it fetches and refuses nobody."""

    tenant: str = Depends(fetch_tenant)


class SignedIn(_Controller):
    """This is the class that decides it. Nothing below mentions a caller again."""

    caller = Depends(who_is_asking)


class Reporting(SignedIn):
    """A link in the chain and nothing else. Dropping it would lose every route below."""


class Anyone(_Controller):
    """Deliberately open, and a sibling of the locked one so a rule that reads the file
    instead of the hierarchy has to get one of them wrong."""


class ReportsController(Reporting):
    @reports.get("/reports")
    def list_reports(self):
        return []

    @reports.delete("/reports/{report_id}")
    def delete_report(self, report_id: int):
        return {"deleted": report_id}


class LivenessController(Anyone):
    @public.get("/live")
    def live(self):
        return {"ok": True}
