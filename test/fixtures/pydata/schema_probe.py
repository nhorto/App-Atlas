"""A verification script that asks the database about itself.

Every repo of any age grows one of these: a script that dumps the schema, or checks a
migration landed, by querying the catalog. The queries are real database reads and are
counted as such — but `information_schema.columns` is MySQL's own bookkeeping, not a
table this app owns, and listing it beside `orders` tells a reader the domain has a
table called columns in it (#86).

`shipments` is here on purpose: a real table named in the same file, by the same client,
two lines from the catalog rows. The rule has to take the catalog and leave that alone.
"""
from warehouse import get_connection


def column_types(cur, table):
    # Spelled in caps, the way MySQL's own documentation writes it.
    cur.execute(
        "SELECT COLUMN_NAME, DATA_TYPE FROM information_schema.COLUMNS "
        "WHERE TABLE_NAME = %s",
        (table,),
    )
    return cur.fetchall()


def table_count(cur):
    cur.execute("SELECT COUNT(*) FROM information_schema.tables WHERE TABLE_SCHEMA = DATABASE()")
    return cur.fetchone()[0]


def trigger_names(cur):
    cur.execute("SELECT TRIGGER_NAME FROM information_schema.triggers")
    return [row[0] for row in cur.fetchall()]


def pending_shipments(cur):
    cur.execute("SELECT id, order_id FROM shipments WHERE dispatched_at IS NULL")
    return cur.fetchall()
