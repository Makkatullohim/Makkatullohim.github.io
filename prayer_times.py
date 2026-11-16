"""Small read-only API for Islam.uz prayer-time tables for Tashkent."""

import json
import os
import re
import threading
from datetime import datetime
from html.parser import HTMLParser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.error import URLError
from urllib.parse import parse_qs, urlparse
from urllib.request import Request, urlopen
from zoneinfo import ZoneInfo

from webapp_api import (
    APIError,
    change_progress,
    get_admin_stats,
    get_progress,
    grant_sync_consent,
    import_local_progress,
    record_section_view,
    validate_init_data,
)


TIMEZONE = ZoneInfo(os.environ.get("BOT_TIMEZONE", "Asia/Tashkent"))
SOURCE_TEMPLATE = "https://islam.uz/vremyanamazov/27/{month}"
TIME_RE = re.compile(r"^\d{1,2}:\d{2}$")
MONTH_CACHE = {}
CACHE_LOCK = threading.Lock()

RU_GREGORIAN_MONTHS = {
    "январь": 1,
    "февраль": 2,
    "март": 3,
    "апрель": 4,
    "май": 5,
    "июнь": 6,
    "июль": 7,
    "август": 8,
    "сентябрь": 9,
    "октябрь": 10,
    "ноябрь": 11,
    "декабрь": 12,
}
HIJRI_MONTHS = {
    "мухаррам": 1,
    "сафар": 2,
    "рабиуль аввал": 3,
    "рабиус аввал": 3,
    "рабиуль сани": 4,
    "рабиус сани": 4,
    "рабиуль охир": 4,
    "рабиус охир": 4,
    "джумадаул аввал": 5,
    "джумадауль аввал": 5,
    "джумадаул сани": 6,
    "джумадауль сани": 6,
    "раджаб": 7,
    "шаъбан": 8,
    "шабан": 8,
    "рамадан": 9,
    "рамазон": 9,
    "шавваль": 10,
    "зулькаъда": 11,
    "зулкаъда": 11,
    "зуль хижжа": 12,
    "зульхижжа": 12,
    "зулхижжа": 12,
}


class PrayerPageParser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.rows = []
        self.text_parts = []
        self._row = None
        self._cell = None

    def handle_starttag(self, tag, attrs):
        if tag == "tr":
            self._row = []
        elif tag in ("td", "th") and self._row is not None:
            self._cell = []

    def handle_data(self, data):
        if data.strip():
            self.text_parts.append(data.strip())
        if self._cell is not None:
            self._cell.append(data)

    def handle_endtag(self, tag):
        if tag in ("td", "th") and self._cell is not None and self._row is not None:
            self._row.append(" ".join(" ".join(self._cell).split()))
            self._cell = None
        elif tag == "tr" and self._row is not None:
            if self._row:
                self.rows.append(self._row)
            self._row = None


def _parse_hijri_anchor(text):
    normalized = " ".join(text.split())
    match = re.search(
        r"(?P<hyear>\d{4})\s*год\s*(?P<hday>\d{1,2})\s+(?P<hmonth>[А-Яа-яЁё]+(?:\s+[А-Яа-яЁё]+)?)\s*\|\s*"
        r"(?P<gyear>\d{4})\s*год\s*(?P<gday>\d{1,2})\s+(?P<gmonth>[А-Яа-яЁё]+)",
        normalized,
        re.IGNORECASE,
    )
    if not match:
        return None
    hijri_month = HIJRI_MONTHS.get(match.group("hmonth").lower())
    gregorian_month = RU_GREGORIAN_MONTHS.get(match.group("gmonth").lower())
    if not hijri_month or not gregorian_month:
        return None
    try:
        gregorian = datetime(
            int(match.group("gyear")), gregorian_month, int(match.group("gday"))
        )
    except ValueError:
        return None
    return {
        "gregorian": gregorian.strftime("%Y-%m-%d"),
        "year": int(match.group("hyear")),
        "month": hijri_month,
        "day": int(match.group("hday")),
    }


def _parse_month_page(html, year, month):
    parser = PrayerPageParser()
    parser.feed(html)
    records = {}
    for cells in parser.rows:
        if not cells or not re.fullmatch(r"\d{1,2}", cells[0].strip()):
            continue
        day = int(cells[0])
        times = [cell.strip() for cell in cells if TIME_RE.fullmatch(cell.strip())]
        if len(times) < 6:
            continue
        date = f"{year:04d}-{month:02d}-{day:02d}"
        records[date] = {
            "date": date,
            "weekday_source": cells[1].strip() if len(cells) > 1 else "",
            "fajr": times[0],
            "sunrise": times[1],
            "dhuhr": times[2],
            "asr": times[3],
            "maghrib": times[4],
            "isha": times[5],
        }
    if not records:
        raise ValueError("Islam.uz саҳифасида Тошкент намоз жадвали топилмади.")
    return {
        "year": year,
        "month": month,
        "source": SOURCE_TEMPLATE.format(month=month),
        "rows": list(records.values()),
        "hijri_anchor": _parse_hijri_anchor(" ".join(parser.text_parts)),
    }


def get_month(year, month):
    key = (year, month)
    with CACHE_LOCK:
        cached = MONTH_CACHE.get(key)
    if cached:
        return cached

    current_year = datetime.now(TIMEZONE).year
    if year != current_year:
        raise ValueError(
            f"Islam.uz ҳозир {current_year}-йил жадвалини беряпти; шу йил ойини танланг."
        )
    if not 1 <= month <= 12:
        raise ValueError("Ой 1 дан 12 гача бўлиши керак.")

    url = SOURCE_TEMPLATE.format(month=month)
    request = Request(
        url,
        headers={"User-Agent": "DilDaftariPrayerTimes/1.0 (+https://islam.uz)"},
    )
    try:
        with urlopen(request, timeout=20) as response:
            html = response.read().decode("utf-8", errors="replace")
    except (URLError, TimeoutError, OSError) as error:
        raise ValueError("Islam.uz манбасига ҳозир уланиб бўлмади.") from error

    data = _parse_month_page(html, year, month)
    with CACHE_LOCK:
        MONTH_CACHE[key] = data
    return data


class PrayerAPIHandler(BaseHTTPRequestHandler):
    def _cors_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Telegram-Init-Data")

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors_headers()
        self.end_headers()

    def do_GET(self):
        request = urlparse(self.path)
        if request.path in ("/", "/health"):
            self._respond(200, {"status": "ok"})
            return
        if request.path in ("/api/progress", "/api/admin/stats"):
            try:
                user_id = self._authenticated_user()
                if request.path == "/api/progress":
                    payload = get_progress(user_id)
                else:
                    payload = get_admin_stats(user_id, self.server.admin_ids)
                self._respond(200, payload, cache_control="no-store")
            except APIError as error:
                self._respond(error.status, {"error": str(error)}, cache_control="no-store")
            except Exception:
                self._respond(500, {"error": "Серверда хатолик юз берди."}, cache_control="no-store")
            return
        if request.path != "/api/prayer-times":
            self._respond(404, {"error": "Манзил топилмади."})
            return
        values = parse_qs(request.query)
        try:
            year = int(values.get("year", [""])[0])
            month = int(values.get("month", [""])[0])
            data = get_month(year, month)
        except (ValueError, TypeError) as error:
            self._respond(400, {"error": str(error)})
            return
        self._respond(200, data)

    def do_POST(self):
        request = urlparse(self.path)
        try:
            user_id = self._authenticated_user()
            payload = self._read_json()
            if request.path == "/api/progress/consent":
                result = grant_sync_consent(user_id)
            elif request.path == "/api/progress/import":
                result = import_local_progress(
                    user_id,
                    payload.get("day"),
                    payload.get("counts", {}),
                )
            elif request.path == "/api/progress/change":
                result = change_progress(
                    user_id,
                    payload.get("operation_id"),
                    payload.get("day"),
                    payload.get("stage"),
                    payload.get("amount"),
                )
            elif request.path == "/api/progress/reset":
                result = change_progress(
                    user_id,
                    payload.get("operation_id"),
                    payload.get("day"),
                    payload.get("stage"),
                    reset=True,
                )
            elif request.path == "/api/analytics/section":
                result = record_section_view(user_id, payload.get("section"))
            else:
                self._respond(404, {"error": "Манзил топилмади."}, cache_control="no-store")
                return
            self._respond(200, result, cache_control="no-store")
        except APIError as error:
            self._respond(error.status, {"error": str(error)}, cache_control="no-store")
        except (ValueError, TypeError, json.JSONDecodeError):
            self._respond(400, {"error": "Сўров маълумотлари нотўғри."}, cache_control="no-store")
        except Exception:
            self._respond(500, {"error": "Серверда хатолик юз берди."}, cache_control="no-store")

    def _authenticated_user(self):
        raw_init_data = self.headers.get("X-Telegram-Init-Data", "")
        return validate_init_data(raw_init_data, self.server.bot_token)

    def _read_json(self):
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError as error:
            raise APIError(400, "Сўров ҳажми нотўғри.") from error
        if length < 0 or length > 8192:
            raise APIError(413, "Сўров ҳажми жуда катта.")
        try:
            payload = json.loads(self.rfile.read(length).decode("utf-8")) if length else {}
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise APIError(400, "Сўров JSON форматида бўлиши керак.") from error
        if not isinstance(payload, dict):
            raise APIError(400, "Сўров маълумотлари объект бўлиши керак.")
        return payload

    def _respond(self, status, payload, cache_control="public, max-age=21600"):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self._cors_headers()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", cache_control)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format_string, *args):
        return


def start_prayer_api_server(bot_token="", admin_ids=None):
    host = os.environ.get("PRAYER_API_HOST", "0.0.0.0")
    port = int(os.environ.get("PORT", os.environ.get("PRAYER_API_PORT", "8000")))
    server = ThreadingHTTPServer((host, port), PrayerAPIHandler)
    server.bot_token = bot_token
    server.admin_ids = set(admin_ids or ())
    thread = threading.Thread(target=server.serve_forever, daemon=True, name="prayer-times-api")
    thread.start()
    print(f"Prayer times API listening on {host}:{port}")
    return server
