"""The file that holds the check — and that Python 3 will not parse.

`except A, B:` is Python 2. This is not a contrived fixture: FastAPI's own
full-stack template ships exactly this line in `backend/app/api/deps.py` on
`master`, which is how App Atlas came to report all 21 of its routes as
unprotected when every one of them is behind a token check.
"""
from typing import Annotated

from fastapi import Depends, HTTPException
from jwt.exceptions import InvalidTokenError
from pydantic import ValidationError


def get_current_user(token: str = Depends(lambda: "")) -> str:
    try:
        return decode(token)
    except InvalidTokenError, ValidationError:
        raise HTTPException(status_code=401, detail="Could not validate credentials")


CurrentUser = Annotated[str, Depends(get_current_user)]
