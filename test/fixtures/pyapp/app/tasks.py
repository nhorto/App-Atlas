"""Work that happens without anybody asking."""

from celery import Celery

from .db import get_session, list_users

queue = Celery("sample")


@queue.task
def email_digest():
    """Sends everyone their weekly summary."""
    session = get_session()
    return list_users(session, 500)
