"""Where the connection is made, and the only line that says which database it is.

SQLAlchemy is the same import whatever is underneath it, so the URL is the answer. The
URL is also where the password is, which is why it never reaches a snippet.
"""
from sqlalchemy import create_engine

engine = create_engine("postgresql+psycopg://reports:hunter2@db.internal/analytics")
