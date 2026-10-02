"""
A plain, inspectable log of every request CYRUS received and what it did
with it. This is NOT "AI memory" in the ambient sense — it is a transcript,
on purpose, so the system's behavior is always auditable by reading a table.
"""

import sqlite3
import time
from pathlib import Path

DB_PATH = Path(__file__).resolve().parent.parent / "cyrus_log.sqlite3"


class Log:
    def __init__(self):
        self.conn = sqlite3.connect(DB_PATH)
        self.conn.execute(
            """
            CREATE TABLE IF NOT EXISTS log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                ts REAL,
                user_text TEXT,
                intent TEXT,
                fields TEXT,
                risk TEXT,
                confirmed INTEGER,
                ok INTEGER,
                message TEXT
            )
            """
        )
        self.conn.commit()

    def record(self, user_text, intent, fields, risk, confirmed, ok, message):
        self.conn.execute(
            "INSERT INTO log (ts, user_text, intent, fields, risk, confirmed, ok, message) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (time.time(), user_text, intent, str(fields), risk, int(confirmed), int(ok), message),
        )
        self.conn.commit()

    def recent(self, limit=20):
        cur = self.conn.execute("SELECT * FROM log ORDER BY id DESC LIMIT ?", (limit,))
        return cur.fetchall()
