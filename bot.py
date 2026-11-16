import json
import os
import sqlite3
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

from telegram import (
    InlineKeyboardButton,
    InlineKeyboardMarkup,
    KeyboardButton,
    ReplyKeyboardMarkup,
    Update,
    WebAppInfo,
)
from telegram.ext import (
    Application,
    CallbackQueryHandler,
    CommandHandler,
    ContextTypes,
)
from prayer_times import start_prayer_api_server
from webapp_api import ensure_webapp_schema, record_user_activity


BASE_DIR = Path(__file__).resolve().parent
LESSONS = json.loads((BASE_DIR / "lessons.json").read_text(encoding="utf-8"))
TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN", "").strip()
DB_PATH = os.environ.get("BOT_DB_PATH", str(BASE_DIR / "bot_data.sqlite3"))
TIMEZONE = ZoneInfo(os.environ.get("BOT_TIMEZONE", "Asia/Tashkent"))
MINI_APP_URL = os.environ.get("MINI_APP_URL", "").strip()
ADMIN_TELEGRAM_IDS = {
    int(value.strip())
    for value in os.environ.get("ADMIN_TELEGRAM_IDS", "").split(",")
    if value.strip().isdigit()
}


@contextmanager
def connect_db():
    connection = sqlite3.connect(DB_PATH)
    connection.row_factory = sqlite3.Row
    try:
        yield connection
        connection.commit()
    except Exception:
        connection.rollback()
        raise
    finally:
        connection.close()


def init_db():
    with connect_db() as connection:
        connection.execute(
            """CREATE TABLE IF NOT EXISTS users (
                user_id INTEGER PRIMARY KEY,
                current_stage INTEGER NOT NULL DEFAULT 0
            )"""
        )
        connection.execute(
            """CREATE TABLE IF NOT EXISTS daily_progress (
                user_id INTEGER NOT NULL,
                day TEXT NOT NULL,
                stage INTEGER NOT NULL,
                count INTEGER NOT NULL DEFAULT 0,
                done INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (user_id, day, stage)
            )"""
        )
        connection.execute(
            """CREATE TABLE IF NOT EXISTS reminders (
                user_id INTEGER NOT NULL,
                lesson_index INTEGER NOT NULL,
                reminder_time TEXT NOT NULL,
                last_sent_date TEXT,
                PRIMARY KEY (user_id, lesson_index)
            )"""
        )
        ensure_webapp_schema(connection)


def today_string():
    return datetime.now(TIMEZONE).date().isoformat()


def ensure_user(connection, user_id):
    connection.execute(
        "INSERT OR IGNORE INTO users (user_id, current_stage) VALUES (?, 0)",
        (user_id,),
    )


def get_today_progress(user_id, lesson_index):
    day = today_string()
    with connect_db() as connection:
        ensure_user(connection, user_id)
        connection.execute(
            """INSERT OR IGNORE INTO daily_progress (user_id, day, stage, count, done)
               VALUES (?, ?, ?, 0, 0)""",
            (user_id, day, lesson_index),
        )
        progress = connection.execute(
            """SELECT count, done FROM daily_progress
               WHERE user_id = ? AND day = ? AND stage = ?""",
            (user_id, day, lesson_index),
        ).fetchone()
        return day, progress["count"], bool(progress["done"])


def all_today_progress(user_id):
    day = today_string()
    with connect_db() as connection:
        ensure_user(connection, user_id)
        rows = connection.execute(
            "SELECT stage, count, done FROM daily_progress WHERE user_id = ? AND day = ?",
            (user_id, day),
        ).fetchall()
    progress = {row["stage"]: (row["count"], bool(row["done"])) for row in rows}
    return day, [progress.get(index, (0, False)) for index in range(len(LESSONS))]


def change_count(user_id, day, lesson_index, amount):
    with connect_db() as connection:
        ensure_user(connection, user_id)
        progress = connection.execute(
            """SELECT count, done FROM daily_progress
               WHERE user_id = ? AND day = ? AND stage = ?""",
            (user_id, day, lesson_index),
        ).fetchone()
        if not progress or progress["done"]:
            return None

        target = LESSONS[lesson_index]["count"]
        count = max(0, min(target, progress["count"] + amount))
        done = count >= target
        connection.execute(
            """UPDATE daily_progress SET count = ?, done = ?
               WHERE user_id = ? AND day = ? AND stage = ?""",
            (count, int(done), user_id, day, lesson_index),
        )
        return count, done


def reset_count(user_id, day, lesson_index):
    with connect_db() as connection:
        connection.execute(
            """UPDATE daily_progress SET count = 0, done = 0
               WHERE user_id = ? AND day = ? AND stage = ?""",
            (user_id, day, lesson_index),
        )


def menu_keyboard():
    return InlineKeyboardMarkup(
        [
            [InlineKeyboardButton("📿 Бугунги вирд", callback_data="today")],
            [InlineKeyboardButton("📖 Қўлланма", callback_data="guide")],
        ]
    )


def admin_keyboard():
    if not MINI_APP_URL.startswith("https://"):
        return None
    url = f"{MINI_APP_URL.rstrip('/')}/admin.html"
    button = KeyboardButton(
        text="📊 Админ панели",
        web_app=WebAppInfo(url=url),
    )
    return ReplyKeyboardMarkup([[button]], resize_keyboard=True, is_persistent=True)


def mini_app_keyboard():
    if not MINI_APP_URL.startswith("https://"):
        return None
    button = KeyboardButton(
        text="☀️ Зикр нури",
        web_app=WebAppInfo(url=MINI_APP_URL),
    )
    return ReplyKeyboardMarkup([[button]], resize_keyboard=True, is_persistent=True)


def guide_keyboard():
    rows = [
        [InlineKeyboardButton(lesson["title"], callback_data=f"lesson:{index}")]
        for index, lesson in enumerate(LESSONS)
    ]
    rows.append([InlineKeyboardButton("🏠 Меню", callback_data="menu")])
    return InlineKeyboardMarkup(rows)


def lesson_keyboard(index):
    return InlineKeyboardMarkup(
        [
            [InlineKeyboardButton("📿 Бугунги вирд", callback_data="today")],
            [InlineKeyboardButton("⬅️ Қўлланмага қайтиш", callback_data="guide")],
        ]
    )


def today_keyboard(user_id, day):
    _, progress = all_today_progress(user_id)
    rows = []
    row = []
    for index, (lesson, (count, done)) in enumerate(zip(LESSONS, progress)):
        mark = "✅" if done else "▫️"
        label = f"{mark} {index + 1}. {lesson['title']} · {count}/{lesson['count']}"
        row.append(InlineKeyboardButton(label, callback_data=f"today:{index}"))
        if len(row) == 2:
            rows.append(row)
            row = []
    if row:
        rows.append(row)
    rows.append([InlineKeyboardButton("🏠 Меню", callback_data="menu")])
    return InlineKeyboardMarkup(rows)


def count_keyboard(lesson_index, day):
    rows = [
        [
            InlineKeyboardButton("−1", callback_data=f"count:-1:{lesson_index}:{day}"),
            InlineKeyboardButton("+1", callback_data=f"count:1:{lesson_index}:{day}"),
            InlineKeyboardButton("+10", callback_data=f"count:10:{lesson_index}:{day}"),
            InlineKeyboardButton("+100", callback_data=f"count:100:{lesson_index}:{day}"),
        ],
        [InlineKeyboardButton("↩️ Саноқни ноллаш", callback_data=f"reset:{lesson_index}:{day}")],
        [InlineKeyboardButton("⬅️ Барча кунлик дарслар", callback_data="today")],
    ]
    return InlineKeyboardMarkup(rows)


def render_lesson(index):
    lesson = LESSONS[index]
    return (
        f"{lesson['title']}\n\n{lesson['content']}\n\n"
        f"Вирд миқдори: {lesson['count']} марта."
    )


def render_today(day, lesson_index, count, done):
    lesson = LESSONS[lesson_index]
    status = "✅ Бу дарснинг бугунги саноғи якунланди." if done else "Бугунги саноқ"
    return (
        f"📿 {lesson['title']}\n\n{lesson['content']}\n\n"
        f"{status}: {count} / {lesson['count']}\n"
        "Бу дарс ҳар куни ўқилади. Тугмалар орқали саноқни юритинг."
    )


def render_today_list(day, progress):
    lines = [f"📿 Бугунги кунлик вирд · {day}", "", "Тўққиз дарснинг барчаси ҳар куни ўқилади.", ""]
    for index, (lesson, (count, done)) in enumerate(zip(LESSONS, progress)):
        mark = "✅" if done else "▫️"
        lines.append(f"{mark} {index + 1}. {lesson['title']} — {count} / {lesson['count']}")
    lines.extend(["", "Дарсни танлаб, матн ва саноқни очинг."])
    return "\n".join(lines)


async def show_today(target, user_id):
    day, progress = all_today_progress(user_id)
    text = render_today_list(day, progress)
    markup = today_keyboard(user_id, day)

    if isinstance(target, Update):
        await target.message.reply_text(text, reply_markup=markup)
    else:
        await target.edit_message_text(text, reply_markup=markup)


async def show_today_lesson(target, user_id, lesson_index):
    if not 0 <= lesson_index < len(LESSONS):
        return
    day, count, done = get_today_progress(user_id, lesson_index)
    text = render_today(day, lesson_index, count, done)
    markup = count_keyboard(lesson_index, day)
    if isinstance(target, Update):
        await target.message.reply_text(text, reply_markup=markup)
    else:
        await target.edit_message_text(text, reply_markup=markup)


async def start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    record_user_activity(update.effective_user.id)
    message = (
        "Ассалому алайкум!\n\n"
        "Telegram орқали профилингиз автоматик яратилади. Синхронлашни ёқсангиз, саноқларингиз бир жойда сақланиб, бошқа қурилмада ҳам очилади.\n\n"
        "Тўққиз дарснинг барчаси ҳар куни ўқилади. Ҳар бир дарс саноғи кунма-кун алоҳида сақланади.\n\n"
        "Фойдаланиш статистикаси умумий кўринишда ҳисобланади; қайси матнни ким ўқигани бўйича шахсий тарих сақланмайди."
    )
    app_keyboard = mini_app_keyboard()
    if app_keyboard:
        await update.message.reply_text(
            "Зикрларни ўқиш ва санаш учун қуйидаги тугмани босинг.",
            reply_markup=app_keyboard,
        )
    elif MINI_APP_URL:
        await update.message.reply_text(
            "Илова манзили https:// билан бошланиши керак. Бот созламасида MINI_APP_URL ни текширинг."
        )
    await update.message.reply_text(message, reply_markup=menu_keyboard())


async def today_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    record_user_activity(update.effective_user.id)
    await show_today(update, update.effective_user.id)


async def guide_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    record_user_activity(update.effective_user.id)
    await update.message.reply_text(
        "Қўлланма — дарсни танланг:", reply_markup=guide_keyboard()
    )


async def delete_data(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user_id = update.effective_user.id
    with connect_db() as connection:
        connection.execute("DELETE FROM daily_progress WHERE user_id = ?", (user_id,))
        connection.execute("DELETE FROM users WHERE user_id = ?", (user_id,))
        connection.execute("DELETE FROM reminders WHERE user_id = ?", (user_id,))
        connection.execute("DELETE FROM user_activity WHERE user_id = ?", (user_id,))
        connection.execute("DELETE FROM sync_settings WHERE user_id = ?", (user_id,))
        connection.execute("DELETE FROM progress_imports WHERE user_id = ?", (user_id,))
        connection.execute("DELETE FROM progress_operations WHERE user_id = ?", (user_id,))
    await update.message.reply_text(
        "Telegram профилингиз ва сервердаги шахсий саноқларингиз ўчирилди. Илованинг бу қурилмадаги маҳаллий маълумотлари қурилмангизда қолади.",
        reply_markup=menu_keyboard(),
    )


async def button_handler(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    user_id = update.effective_user.id
    record_user_activity(user_id)
    data = query.data

    if data == "menu":
        await query.edit_message_text(
            "Керакли бўлимни танланг:", reply_markup=menu_keyboard()
        )
        await query.answer()
    elif data == "today":
        await show_today(query, user_id)
        await query.answer()
    elif data.startswith("today:"):
        index = int(data.split(":", 1)[1])
        if 0 <= index < len(LESSONS):
            await show_today_lesson(query, user_id, index)
        await query.answer()
    elif data == "guide":
        await query.edit_message_text(
            "Қўлланма — дарсни танланг:", reply_markup=guide_keyboard()
        )
        await query.answer()
    elif data.startswith("lesson:"):
        index = int(data.split(":", 1)[1])
        if 0 <= index < len(LESSONS):
            await query.edit_message_text(
                render_lesson(index), reply_markup=lesson_keyboard(index)
            )
        await query.answer()
    elif data.startswith("count:"):
        _, amount_text, lesson_text, day = data.split(":", 3)
        lesson_index = int(lesson_text)
        if not 0 <= lesson_index < len(LESSONS):
            await query.answer("Дарс топилмади.", show_alert=True)
            return
        if day != today_string():
            await query.answer("Кун янгиланди. Бугунги вирдни қайта очинг.", show_alert=True)
            return
        current_day, _, already_done = get_today_progress(user_id, lesson_index)
        if current_day != day or already_done:
            await query.answer("Бугунги вирдни қайта очинг.", show_alert=True)
            return
        result = change_count(user_id, day, lesson_index, int(amount_text))
        if result is not None:
            count, done = result
            await query.edit_message_text(
                render_today(day, lesson_index, count, done),
                reply_markup=count_keyboard(lesson_index, day),
            )
        await query.answer()
    elif data.startswith("reset:"):
        _, lesson_text, day = data.split(":", 2)
        lesson_index = int(lesson_text)
        if day == today_string():
            current_day, _, _ = get_today_progress(user_id, lesson_index)
            if current_day == day:
                reset_count(user_id, day, lesson_index)
        await show_today_lesson(query, user_id, lesson_index)
        await query.answer()


async def help_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    record_user_activity(update.effective_user.id)
    await update.message.reply_text(
        "/today — бугунги 9 дарсни очиш\n"
        "/guide — қўлланмадан дарс танлаш\n"
        "/myid — Telegram ID’нгизни кўриш\n"
        "/admin — админ панели (админлар учун)\n"
        "/delete_data — профил ва шахсий саноқ маълумотларини ўчириш",
        reply_markup=menu_keyboard(),
    )


async def my_id_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user_id = update.effective_user.id
    record_user_activity(user_id)
    await update.message.reply_text(f"Сизнинг Telegram ID’нгиз: {user_id}")


async def admin_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user_id = update.effective_user.id
    record_user_activity(user_id)
    if user_id not in ADMIN_TELEGRAM_IDS:
        await update.message.reply_text("Бу бўлим фақат админлар учун.")
        return
    keyboard = admin_keyboard()
    if keyboard is None:
        await update.message.reply_text("Админ панели учун MINI_APP_URL HTTPS манзили созланмаган.")
        return
    await update.message.reply_text(
        "Умумий фойдаланиш статистикасини кўриш учун панелни очинг.",
        reply_markup=keyboard,
    )


def main():
    if not TOKEN:
        raise SystemExit(
            "TELEGRAM_BOT_TOKEN муҳит ўзгарувчиси берилмаган. README.md даги йўриқномага қаранг."
        )
    init_db()
    start_prayer_api_server(TOKEN, ADMIN_TELEGRAM_IDS)
    application = Application.builder().token(TOKEN).build()
    application.add_handler(CommandHandler("start", start))
    application.add_handler(CommandHandler("today", today_command))
    application.add_handler(CommandHandler("guide", guide_command))
    application.add_handler(CommandHandler("help", help_command))
    application.add_handler(CommandHandler("delete_data", delete_data))
    application.add_handler(CommandHandler("myid", my_id_command))
    application.add_handler(CommandHandler("admin", admin_command))
    application.add_handler(CallbackQueryHandler(button_handler))
    application.run_polling()


if __name__ == "__main__":
    main()
