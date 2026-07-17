import os
import sqlite3
from datetime import datetime
from pathlib import Path
from urllib.parse import parse_qs, urlparse


STATE_DIR = Path(os.getenv("LUOPAN_STATE_DIR", Path(__file__).parent / "state"))
DB_PATH = STATE_DIR / "metrics.db"


def init_db():
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS metrics (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            captured_at TEXT NOT NULL,
            url TEXT NOT NULL,
            body_preview TEXT NOT NULL
        )
        """
    )
    columns = [row[1] for row in conn.execute("PRAGMA table_info(metrics)").fetchall()]
    for column, column_type in (
        ("body", "TEXT"),
        ("shop_id", "TEXT"),
        ("shop_name", "TEXT"),
        ("data_date", "TEXT"),
        ("date_type", "TEXT"),
        ("endpoint", "TEXT"),
    ):
        if column not in columns:
            conn.execute(f"ALTER TABLE metrics ADD COLUMN {column} {column_type}")
    conn.commit()
    return conn


def parse_url_fields(url):
    parsed = urlparse(url)
    query = parse_qs(parsed.query)
    raw_date = query.get("begin_date", [""])[0]
    data_date = raw_date.split()[0].replace("/", "-") if raw_date else None
    return {
        "data_date": data_date,
        "date_type": query.get("date_type", [None])[0],
        "endpoint": parsed.path,
    }


def insert(conn, url, body_preview, body=None, shop_id=None, shop_name=None):
    fields = parse_url_fields(url)
    conn.execute(
        """
        INSERT INTO metrics (
            captured_at, url, body_preview, body, shop_id, shop_name,
            data_date, date_type, endpoint
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            datetime.now().isoformat(timespec="seconds"),
            url,
            body_preview,
            body,
            shop_id,
            shop_name,
            fields["data_date"],
            fields["date_type"],
            fields["endpoint"],
        ),
    )
    conn.commit()


def query_all(conn):
    cursor = conn.execute(
        "SELECT id, captured_at, url, body_preview FROM metrics ORDER BY id"
    )
    return cursor.fetchall()
