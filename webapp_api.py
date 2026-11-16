"""Authenticated Telegram Mini App progress and aggregate usage helpers."""

from contextlib import contextmanager
from datetime import datetime, timedelta
import hashlib
import hmac
import json
import os
from pathlib import Path
import sqlite3
from urllib.parse import parse_qs
from zoneinfo import ZoneInfo


BASE_DIR = Path(__file__).resolve().parent
DB_PATH = os.environ.get("BOT_DB_PATH", str(BASE_DIR / "bot_data.sqlite3"))
TIMEZONE = ZoneInfo(os.environ.get("BOT_TIMEZONE", "Asia/Tashkent"))
LESSONS = json.loads((BASE_DIR / "lessons.json").read_text(encoding="utf-8"))
VALID_SECTIONS = {"tariqat", "today", "prayers", "memory", "places", "guide"}


class APIError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status


@contextmanager
def connect_db():
    connection = sqlite3.connect(DB_PATH, timeout=15)
    connection.row_factory = sqlite3.Row
    try:
        yield connection
        connection.commit()
    except Exception:
        connection.rollback()
        raise
    finally:
        connection.close()


def ensure_webapp_schema(connection):
    connection.execute(
        """CREATE TABLE IF NOT EXISTS user_activity (
            user_id INTEGER NOT NULL,
            day TEXT NOT NULL,
            PRIMARY KEY (user_id, day)
        )"""
    )
    connection.execute(
        """CREATE TABLE IF NOT EXISTS section_views (
            day TEXT NOT NULL,
            section TEXT NOT NULL,
            views INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (day, section)
        )"""
    )
    connection.execute(
        """CREATE TABLE IF NOT EXISTS sync_settings (
            user_id INTEGER PRIMARY KEY,
            consented_at TEXT NOT NULL
        )"""
    )
    connection.execute(
        """CREATE TABLE IF NOT EXISTS progress_imports (
            user_id INTEGER NOT NULL,
            day TEXT NOT NULL,
            imported_at TEXT NOT NULL,
            PRIMARY KEY (user_id, day)
        )"""
    )
    connection.execute(
        """CREATE TABLE IF NOT EXISTS progress_operations (
            user_id INTEGER NOT NULL,
            operation_id TEXT NOT NULL,
            created_at TEXT NOT NULL,
            PRIMARY KEY (user_id, operation_id)
        )"""
    )


def today_string():
    return datetime.now(TIMEZONE).date().isoformat()


def _now_string():
    return datetime.now(TIMEZONE).isoformat(timespec="seconds")


def _record_activity(connection, user_id, day=None):
    connection.execute(
        "INSERT OR IGNORE INTO users (user_id, current_stage) VALUES (?, 0)",
        (user_id,),
    )
    connection.execute(
        "INSERT OR IGNORE INTO user_activity (user_id, day) VALUES (?, ?)",
        (user_id, day or today_string()),
    )


def record_user_activity(user_id):
    with connect_db() as connection:
        ensure_webapp_schema(connection)
        _record_activity(connection, user_id)


def validate_init_data(raw_init_data, bot_token, max_age_seconds=86400):
    if not raw_init_data or not bot_token:
        raise APIError(401, "Telegram профили орқали қайта очинг.")

    try:
        parsed = parse_qs(raw_init_data, keep_blank_values=True, strict_parsing=True)
        if any(len(values) != 1 for values in parsed.values()):
            raise ValueError("duplicate values")
        values = {key: items[0] for key, items in parsed.items()}
        received_hash = values.pop("hash", "")
        auth_date = int(values.get("auth_date", "0"))
        user = json.loads(values["user"])
        user_id = int(user["id"])
    except (KeyError, TypeError, ValueError, json.JSONDecodeError) as error:
        raise APIError(401, "Telegram тасдиқ маълумоти нотўғри.") from error

    data_check_string = "\n".join(
        f"{key}={value}" for key, value in sorted(values.items())
    )
    secret_key = hmac.new(
        b"WebAppData", bot_token.encode("utf-8"), hashlib.sha256
    ).digest()
    expected_hash = hmac.new(
        secret_key, data_check_string.encode("utf-8"), hashlib.sha256
    ).hexdigest()
    if not received_hash or not hmac.compare_digest(expected_hash, received_hash):
        raise APIError(401, "Telegram профили тасдиқланмади.")

    now = int(datetime.now().timestamp())
    if auth_date > now + 60 or now - auth_date > max_age_seconds:
        raise APIError(401, "Telegram сессияси янгиланган. Иловани қайта очинг.")
    return user_id


def grant_sync_consent(user_id):
    with connect_db() as connection:
        ensure_webapp_schema(connection)
        _record_activity(connection, user_id)
        connection.execute(
            """INSERT INTO sync_settings (user_id, consented_at) VALUES (?, ?)
               ON CONFLICT(user_id) DO UPDATE SET consented_at = excluded.consented_at""",
            (user_id, _now_string()),
        )
    return {"sync_enabled": True}


def _has_consent(connection, user_id):
    return connection.execute(
        "SELECT 1 FROM sync_settings WHERE user_id = ?", (user_id,)
    ).fetchone() is not None


def get_progress(user_id):
    day = today_string()
    with connect_db() as connection:
        ensure_webapp_schema(connection)
        if not _has_consent(connection, user_id):
            raise APIError(403, "Саноқларни синхронлаш учун розилик керак.")
        _record_activity(connection, user_id, day)
        connection.execute(
            "DELETE FROM progress_imports WHERE user_id = ? AND day < ?",
            (user_id, day),
        )
        rows = connection.execute(
            """SELECT stage, count, done FROM daily_progress
               WHERE user_id = ? AND day = ?""",
            (user_id, day),
        ).fetchall()
        imported = connection.execute(
            "SELECT 1 FROM progress_imports WHERE user_id = ? AND day = ?",
            (user_id, day),
        ).fetchone()
    progress = {row["stage"]: (row["count"], bool(row["done"])) for row in rows}
    values = [progress.get(index, (0, False)) for index in range(len(LESSONS))]
    return {
        "day": day,
        "counts": [count for count, _ in values],
        "done": [done for _, done in values],
        "needs_import": imported is None,
    }


def import_local_progress(user_id, day, counts):
    if day != today_string():
        raise APIError(409, "Фақат бугунги саноқни олиб ўтиш мумкин.")
    if not isinstance(counts, dict):
        raise APIError(400, "Саноқлар рўйхати нотўғри.")

    now = _now_string()
    with connect_db() as connection:
        ensure_webapp_schema(connection)
        if not _has_consent(connection, user_id):
            raise APIError(403, "Аввал синхронлашни ёқинг.")
        connection.execute("BEGIN IMMEDIATE")
        _record_activity(connection, user_id, day)
        already_imported = connection.execute(
            "SELECT 1 FROM progress_imports WHERE user_id = ? AND day = ?",
            (user_id, day),
        ).fetchone()
        if already_imported is None:
            for index, lesson in enumerate(LESSONS):
                raw_count = counts.get(str(index), counts.get(index, 0))
                try:
                    local_count = max(0, min(int(lesson["count"]), int(raw_count)))
                except (TypeError, ValueError):
                    local_count = 0
                connection.execute(
                    """INSERT OR IGNORE INTO daily_progress (user_id, day, stage, count, done)
                       VALUES (?, ?, ?, 0, 0)""",
                    (user_id, day, index),
                )
                current = connection.execute(
                    """SELECT count FROM daily_progress
                       WHERE user_id = ? AND day = ? AND stage = ?""",
                    (user_id, day, index),
                ).fetchone()["count"]
                count = max(current, local_count)
                target = int(lesson["count"])
                connection.execute(
                    """UPDATE daily_progress SET count = ?, done = ?
                       WHERE user_id = ? AND day = ? AND stage = ?""",
                    (count, int(count >= target), user_id, day, index),
                )
            connection.execute(
                "INSERT INTO progress_imports (user_id, day, imported_at) VALUES (?, ?, ?)",
                (user_id, day, now),
            )
    return get_progress(user_id)


def change_progress(user_id, operation_id, day, stage, amount=None, reset=False):
    if day != today_string():
        raise APIError(409, "Кун янгиланди. Бугунги вирдни қайта очинг.")
    if not isinstance(operation_id, str) or not (8 <= len(operation_id) <= 80):
        raise APIError(400, "Сўров рақами нотўғри.")
    if not isinstance(stage, int) or not 0 <= stage < len(LESSONS):
        raise APIError(400, "Дарс топилмади.")
    if not reset and (not isinstance(amount, int) or not -100 <= amount <= 100):
        raise APIError(400, "Саноқ ўзгариши нотўғри.")

    target = int(LESSONS[stage]["count"])
    with connect_db() as connection:
        ensure_webapp_schema(connection)
        if not _has_consent(connection, user_id):
            raise APIError(403, "Аввал синхронлашни ёқинг.")
        connection.execute("BEGIN IMMEDIATE")
        _record_activity(connection, user_id, day)
        duplicate = connection.execute(
            "SELECT 1 FROM progress_operations WHERE user_id = ? AND operation_id = ?",
            (user_id, operation_id),
        ).fetchone()
        if duplicate is None:
            connection.execute(
                """INSERT OR IGNORE INTO daily_progress (user_id, day, stage, count, done)
                   VALUES (?, ?, ?, 0, 0)""",
                (user_id, day, stage),
            )
            row = connection.execute(
                """SELECT count, done FROM daily_progress
                   WHERE user_id = ? AND day = ? AND stage = ?""",
                (user_id, day, stage),
            ).fetchone()
            if reset:
                count = 0
            elif row["done"]:
                count = row["count"]
            else:
                count = max(0, min(target, row["count"] + amount))
            done = count >= target
            connection.execute(
                """UPDATE daily_progress SET count = ?, done = ?
                   WHERE user_id = ? AND day = ? AND stage = ?""",
                (count, int(done), user_id, day, stage),
            )
            connection.execute(
                "INSERT INTO progress_operations (user_id, operation_id, created_at) VALUES (?, ?, ?)",
                (user_id, operation_id, _now_string()),
            )
            connection.execute(
                "DELETE FROM progress_operations WHERE created_at < ?",
                ((datetime.now(TIMEZONE) - timedelta(days=7)).isoformat(timespec="seconds"),),
            )
        result = connection.execute(
            """SELECT count, done FROM daily_progress
               WHERE user_id = ? AND day = ? AND stage = ?""",
            (user_id, day, stage),
        ).fetchone()
    return {"day": day, "stage": stage, "count": result["count"], "done": bool(result["done"])}


def record_section_view(user_id, section):
    if section not in VALID_SECTIONS:
        raise APIError(400, "Бўлим топилмади.")
    day = today_string()
    with connect_db() as connection:
        ensure_webapp_schema(connection)
        if not _has_consent(connection, user_id):
            raise APIError(403, "Синхронлаш ёқилмаган.")
        connection.execute("BEGIN IMMEDIATE")
        _record_activity(connection, user_id, day)
        connection.execute(
            """INSERT INTO section_views (day, section, views) VALUES (?, ?, 1)
               ON CONFLICT(day, section) DO UPDATE SET views = views + 1""",
            (day, section),
        )
    return {"recorded": True}


def get_admin_stats(user_id, admin_ids):
    if user_id not in admin_ids:
        raise APIError(403, "Бу панел фақат админлар учун.")
    today = datetime.now(TIMEZONE).date()
    days = [(today - timedelta(days=offset)).isoformat() for offset in range(6, -1, -1)]
    first_day = days[0]
    with connect_db() as connection:
        ensure_webapp_schema(connection)
        total_users = connection.execute("SELECT COUNT(*) FROM users").fetchone()[0]
        active_today = connection.execute(
            "SELECT COUNT(*) FROM user_activity WHERE day = ?", (days[-1],)
        ).fetchone()[0]
        active_7d = connection.execute(
            "SELECT COUNT(DISTINCT user_id) FROM user_activity WHERE day >= ? AND day <= ?",
            (first_day, days[-1]),
        ).fetchone()[0]
        daily_rows = connection.execute(
            """SELECT day, COUNT(DISTINCT user_id) AS active
               FROM user_activity WHERE day >= ? AND day <= ? GROUP BY day""",
            (first_day, days[-1]),
        ).fetchall()
        view_rows = connection.execute(
            """SELECT section, SUM(views) AS views FROM section_views
               WHERE day >= ? AND day <= ? GROUP BY section""",
            (first_day, days[-1]),
        ).fetchall()
        completed_today = connection.execute(
            "SELECT COUNT(*) FROM daily_progress WHERE day = ? AND done = 1",
            (days[-1],),
        ).fetchone()[0]
    activity = {row["day"]: row["active"] for row in daily_rows}
    section_views = {row["section"]: row["views"] for row in view_rows}
    labels = {
        "tariqat": "Бугун",
        "today": "Вирдлар",
        "prayers": "Намоз",
        "memory": "Ёдлаш",
        "places": "Силсила",
        "guide": "Қўлланма",
    }
    return {
        "range_days": 7,
        "total_users": total_users,
        "active_today": active_today,
        "active_7d": active_7d,
        "completed_today": completed_today,
        "daily_active": [{"day": day, "users": activity.get(day, 0)} for day in days],
        "section_views": [
            {"section": key, "label": labels[key], "views": section_views.get(key, 0)}
            for key in labels
        ],
        "privacy_note": "Бўлимлар очилиши фақат умумий ҳисобда кўрсатилади.",
    }

