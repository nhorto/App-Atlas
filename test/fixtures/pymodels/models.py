"""Declarative models, the way a real SQLAlchemy app writes them.

The point of this fixture is the join: the queries in `repo.py` name these tables, and
the columns are only ever declared here. Without the join every table below reports
"columns unknown" while the columns sit in the atlas a few nodes away.
"""
from sqlalchemy import Boolean, String
from sqlalchemy.orm import Mapped, mapped_column

from base import Base


class Customer(Base):
    __tablename__ = "customers"

    id: Mapped[int] = mapped_column(primary_key=True)
    email: Mapped[str] = mapped_column(String, unique=True)
    full_name: Mapped[str | None] = mapped_column(String)
    phone_number: Mapped[str | None] = mapped_column(String)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)


class Invoice(Base):
    """No personal data of its own — it points at the customer that has it."""

    __tablename__ = "invoices"

    id: Mapped[int] = mapped_column(primary_key=True)
    customer_id: Mapped[int] = mapped_column()
    total_cents: Mapped[int] = mapped_column()
    status: Mapped[str] = mapped_column(String)
