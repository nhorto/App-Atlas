"""Hand-written SQL, including the two shapes that used to produce a wrong answer.

An f-string arrives with its holes closed up, so `SELECT * FROM {table} LIMIT {n}` reads
as `SELECT * FROM  LIMIT` — and answering "limit" to "which table" is a table name a
reader could go looking for and never find.
"""
from sqlalchemy import create_engine


def sample(conn, table, n):
    conn.execute(f"SELECT * FROM {table} LIMIT {n}")


def describe(conn):
    conn.execute("SELECT column_name FROM information_schema.columns WHERE table_schema = 'app'")


def totals(conn):
    conn.execute("SELECT sum(total) FROM public.orders")


def purge(conn):
    conn.execute("DELETE FROM item WHERE archived = true")
