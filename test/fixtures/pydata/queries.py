"""Queries written against a connection this file never opens.

A repo of scripts reaches its database through a helper module, so this file imports no
client at all. The `SELECT` is still a database read: the statement is the evidence, and
requiring the import here would lose every query in the repo that has one.
"""
from warehouse import get_connection


def recent_orders(cur):
    cur.execute("SELECT id, total FROM orders ORDER BY placed_at DESC LIMIT 50")
    return cur.fetchall()


def mark_shipped(cur, order_id):
    cur.execute("UPDATE orders SET shipped = 1 WHERE id = %s", (order_id,))
