"""Routes and the queries behind them, in one file, the way people actually write them.

The decorators matter as much as the queries: `@router.get("/items")` is a call whose
method is `get`, and reading method names alone counted every route in the app as a
database read.
"""
from fastapi import APIRouter
from sqlalchemy import select, update
from sqlalchemy.orm import Session

from models import Item

router = APIRouter()


@router.get("/items")
def list_items(db_session: Session):
    return db_session.execute(select(Item)).scalars().all()


@router.get("/items/{item_id}")
def read_item(db_session: Session, item_id: int):
    return db_session.get(Item, item_id)


@router.post("/items")
def create_item(db_session: Session, payload: dict):
    name = payload.get("name")
    item = Item(name=name)
    db_session.add(item)
    db_session.commit()
    return item


@router.put("/items/{item_id}")
def rename_item(db_session: Session, item_id: int, form_data: dict):
    stmt = update(Item).where(Item.id == item_id).values(name=form_data.get("name"))
    db_session.execute(stmt)
    db_session.commit()
