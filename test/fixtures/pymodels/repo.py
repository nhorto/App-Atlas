"""The queries. These are what put the tables on the map at all.

`select(Customer)` records the table under the *class* name, while the raw statement
names `invoices` — the table's own. Both spellings have to reach the same declaration,
which is why the join matches on `__tablename__` and on the class name.
"""
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session

from models import Customer

engine = create_engine("postgresql+psycopg://app:secret@db.internal/billing")


def active_customers(session: Session):
    return session.execute(select(Customer)).scalars().all()


def invoice_totals(conn):
    return conn.execute("SELECT sum(total_cents) FROM invoices")


def customer_emails(conn):
    """Names the table by its own name, which is what `__tablename__` has to match.

    It is also what makes the completeness rule testable: two classes declare
    `customers`, and the five-column model must win over the migration's two-column stub.
    """
    return conn.execute("SELECT email FROM customers")
