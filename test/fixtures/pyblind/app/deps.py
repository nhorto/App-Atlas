"""The file that holds the check — and that Python 3 will not parse.

The first version of this fixture used `except A, B:`, the line FastAPI's own
full-stack template shipped in `backend/app/api/deps.py` — which is how App
Atlas came to report all 21 of its routes as unprotected when every one of
them is behind a token check. Then Python 3.14 (PEP 758) made that exact line
legal again, and on any machine running it this fixture quietly parsed, six
tests went red, and the scenario they guard — a check the analyzer cannot see
is "unexamined", never "unprotected" — was no longer being tested at all. So
the broken line is now a Python 2 `print` statement, which every Python 3 to
date refuses and no PEP proposes to forgive.
"""
from typing import Annotated

from fastapi import Depends, HTTPException
from jwt.exceptions import InvalidTokenError
from pydantic import ValidationError


def get_current_user(token: str = Depends(lambda: "")) -> str:
    try:
        return decode(token)
    except (InvalidTokenError, ValidationError):
        print "Could not validate credentials"
        raise HTTPException(status_code=401, detail="Could not validate credentials")


CurrentUser = Annotated[str, Depends(get_current_user)]
