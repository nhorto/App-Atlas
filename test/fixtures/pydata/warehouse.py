"""The one file that opens the connection, and the credentials it opens it with.

`os.environ.get("MYSQL_HOST")` is a `get` on something, exactly like `session.get` is.
Reading the method name alone made this file's environment lines the evidence for the
MySQL box, and not one line of database code appeared in it.
"""
import os

import pymysql


def get_connection():
    return pymysql.connect(
        host=os.environ.get("MYSQL_HOST"),
        user=os.environ.get("MYSQL_USER"),
        password=os.environ.get("MYSQL_PASSWORD"),
    )


def server_version():
    conn = pymysql.connect(host="localhost")
    cur = conn.cursor()
    cur.execute("SELECT VERSION()")
    return cur.fetchone()
