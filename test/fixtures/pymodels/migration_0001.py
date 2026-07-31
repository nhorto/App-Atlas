"""A migration that redeclares part of a model, the way Alembic does.

This stub is why the join cannot simply refuse when two classes name the same table.
On mealie `RecipeModel` arrives five times — four stubs of three to five columns beside
the real 49-column model — and refusing on the collision left sixteen tables with no
columns at all. The fullest declaration is the model; this is a partial view of it.
"""
from sqlalchemy import String
from sqlalchemy.orm import Mapped, mapped_column

from base import Base


class Customer(Base):
    __tablename__ = "customers"

    id: Mapped[int] = mapped_column(primary_key=True)
    email: Mapped[str] = mapped_column(String)
