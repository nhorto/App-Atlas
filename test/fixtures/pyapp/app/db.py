"""Where the sample app keeps its data."""

import os

from sqlalchemy import Column, ForeignKey, Integer, String, create_engine
from sqlalchemy.orm import Session, declarative_base

Base = declarative_base()
engine = create_engine(os.environ["DATABASE_URL"])


class User(Base):
    """Someone with an account."""

    __tablename__ = "users"

    id = Column(Integer, primary_key=True)
    email = Column(String, unique=True)
    display_name = Column(String, nullable=True)


class Order(Base):
    """Something a user bought."""

    __tablename__ = "orders"

    id = Column(Integer, primary_key=True)
    user_id = Column(ForeignKey("users.id"))
    amount_cents = Column(Integer)


def get_session() -> Session:
    """Hands out a database session, one per request."""
    return Session(engine)


def list_users(session: Session, limit: int = 20):
    """Everyone who has signed up, newest first."""
    return session.query(User).limit(limit).all()


def save_order(session: Session, order: Order) -> None:
    session.add(order)
    session.commit()
