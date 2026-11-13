const app = document.getElementById("app");
const toast = document.getElementById("toast");
const navButtons = [...document.querySelectorAll(".nav-item")];
const telegramApp = window.Telegram?.WebApp;
const timezone = "Asia/Tashkent";
const storageKey = `dil-daftari-v1-${telegramApp?.initDataUnsafe?.user?.id || "local"}`;
const configuredPrayerApi = document.querySelector("meta[name='prayer-api-url']")?.content?.trim().replace(/\/$/, "");
const prayerApiBase = configuredPrayerApi || window.location.origin;
const hijriPartsFormatter = new Intl.DateTimeFormat("en-US-u-ca-islamic-umalqura", {
  timeZone: timezone, year: "numeric", month: "numeric", day: "numeric",
});
const hijriLabelFormatter = new Intl.DateTimeFormat("uz-Cyrl-UZ-u-ca-islamic-umalqura", {
  timeZone: timezone, year: "numeric", month: "long", day: "numeric",
});
const hijriMonthLabelFormatter = new Intl.DateTimeFormat("uz-Cyrl-UZ-u-ca-islamic-umalqura", {
  timeZone: timezone, year: "numeric", month: "long",
});
const weekdayFormatter = new Intl.DateTimeFormat("uz-Cyrl-UZ", {
  timeZone: timezone, weekday: "long",
});

let lessons = [];
let pirData;
let asmaData;
let state;
let route = "today";
let prayerView = "today";
let prayerMonth = localDay().slice(0, 7);
let selectedHijriMonth = "";
let hijriDateShiftDays = 0;
let prayerMonthCache = {};
let memoryType = "pirs";
let selectedPerson = 0;
let selectedPlace = 0;
let selectedLesson = null;
let leafletMap = null;
let toastTimer;

function localDay() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

function formatDate() {
  return new Intl.DateTimeFormat("uz-Cyrl-UZ", {
    timeZone: timezone,
    day: "numeric",
    month: "long",
    weekday: "short",
  }).format(new Date());
}

function dateAtTashkentNoon(dateKey) {
  return new Date(`${dateKey}T07:00:00.000Z`);
}

function addDays(dateKey, amount) {
  const date = new Date(`${dateKey}T12:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}

function monthOf(dateKey) {
  return dateKey.slice(0, 7);
}

function hijriParts(dateKey) {
  const adjustedDate = dateAtTashkentNoon(addDays(dateKey, hijriDateShiftDays));
  const values = Object.fromEntries(hijriPartsFormatter.formatToParts(adjustedDate).map((part) => [part.type, part.value]));
  return {
    year: Number.parseInt(values.year, 10),
    month: Number.parseInt(values.month, 10),
    day: Number.parseInt(values.day, 10),
  };
}

function hijriMonthKey(dateKey) {
  const parts = hijriParts(dateKey);
  return `${parts.year}-${String(parts.month).padStart(2, "0")}`;
}

function formatHijriDate(dateKey) {
  return hijriLabelFormatter.format(dateAtTashkentNoon(addDays(dateKey, hijriDateShiftDays)));
}

function formatHijriMonth(dateKey) {
  return hijriMonthLabelFormatter.format(dateAtTashkentNoon(addDays(dateKey, hijriDateShiftDays)));
}

function applyHijriAnchor(anchor) {
  if (!anchor?.gregorian || !anchor.year || !anchor.month || !anchor.day) return;
  for (let shift = -2; shift <= 2; shift += 1) {
    const parts = hijriPartsFormatter.formatToParts(dateAtTashkentNoon(addDays(anchor.gregorian, shift)));
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    if (Number.parseInt(values.year, 10) === anchor.year
      && Number.parseInt(values.month, 10) === anchor.month
      && Number.parseInt(values.day, 10) === anchor.day) {
      hijriDateShiftDays = shift;
      return;
    }
  }
}

function hijriMonthOptions() {
  const options = new Map();
  const year = Number(localDay().slice(0, 4));
  const start = `${year}-01-01`;
  const days = new Date(Date.UTC(year + 1, 0, 1)).getTime() - new Date(Date.UTC(year, 0, 1)).getTime();
  const count = Math.round(days / 86400000);
  for (let offset = 0; offset < count; offset += 1) {
    const dateKey = addDays(start, offset);
    const key = hijriMonthKey(dateKey);
    if (!options.has(key)) {
      options.set(key, {
        key,
        date: dateKey,
        label: formatHijriMonth(dateKey),
      });
    }
  }
  return [...options.values()];
}

function datesInHijriMonth(monthKey) {
  const dates = [];
  const year = Number(localDay().slice(0, 4));
  const start = `${year}-01-01`;
  const days = new Date(Date.UTC(year + 1, 0, 1)).getTime() - new Date(Date.UTC(year, 0, 1)).getTime();
  const count = Math.round(days / 86400000);
  for (let offset = 0; offset < count; offset += 1) {
    const dateKey = addDays(start, offset);
    if (hijriMonthKey(dateKey) === monthKey) dates.push(dateKey);
  }
  return dates;
}

function emptyState() {
  return {
    daily: null,
    schedule: {},
    completedStages: [],
    memories: {
      pirs: { quota: 1, completed: [], session: null },
      asma: { quota: 3, completed: [], session: null },
    },
  };
}

function loadState() {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey));
    if (saved && typeof saved === "object") {
      const base = emptyState();
      const oldDaily = saved.daily;
      const daily = oldDaily && oldDaily.day
        ? {
            day: oldDaily.day,
            counts: oldDaily.counts && typeof oldDaily.counts === "object"
              ? oldDaily.counts
              : oldDaily.stage !== undefined
                ? { [oldDaily.stage]: Number(oldDaily.count || 0) }
                : {},
          }
        : null;
      return {
        ...base,
        ...saved,
        daily,
        schedule: { ...base.schedule, ...(saved.schedule || {}) },
        memories: {
          ...base.memories,
          ...(saved.memories || {}),
        },
      };
    }
  } catch (_) {
    // A damaged local save should not prevent opening the guide.
  }
  return emptyState();
}

function saveState() {
  localStorage.setItem(storageKey, JSON.stringify(state));
}

function syncDaily() {
  const day = localDay();
  if (!state.daily || state.daily.day !== day) {
    state.daily = {
      day,
      counts: {},
    };
    saveState();
  } else if (!state.daily.counts || typeof state.daily.counts !== "object") {
    state.daily.counts = {};
    saveState();
  }
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function textWithBreaks(value) {
  return escapeHtml(value).replaceAll("\n", "<br>");
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 2200);
}

function updateNav() {
  navButtons.forEach((button) => {
    button.classList.toggle("active", button.dataset.route === route);
  });
}

function pageIntro(label, title, description) {
  return `<div class="page-intro">
    <span class="eyebrow">${escapeHtml(label)}</span>
    <h1>${escapeHtml(title)}</h1>
    <p>${escapeHtml(description)}</p>
  </div>`;
}

function renderCounter(lesson, index, done) {
  const count = Number(state.daily?.counts?.[index] || 0);
  const reminderTime = state.schedule?.[index] || "";
  const percent = Math.min(100, Math.round((count / lesson.count) * 100));
  return `<article class="daily-lesson-card">
    <div class="daily-lesson-heading">
      <span class="guide-num">${String(index + 1).padStart(2, "0")}</span>
      <div><h2>${escapeHtml(lesson.title)}</h2><small>${lesson.count.toLocaleString("uz-UZ")} марта · ҳар куни</small></div>
    </div>
    <label class="reminder-time-row"><span>Кунлик эслатма вақти</span>
      <input type="time" value="${escapeHtml(reminderTime)}" data-action="reminder-time" data-lesson="${index}" aria-label="${escapeHtml(lesson.title)} эслатма вақти">
    </label>
    <section class="counter-card">
    <div class="counter-head">
      <span class="section-label">Бугунги саноқ</span>
      <span class="counter-figures"><b>${count.toLocaleString("uz-UZ")}</b> / ${lesson.count.toLocaleString("uz-UZ")}</span>
    </div>
    <div class="ring-wrap">
      <div class="count-ring" style="--progress:${percent}%">
        <button class="count-button" data-action="count-one" data-lesson="${index}" ${done ? "disabled" : ""} aria-label="${escapeHtml(lesson.title)} саноғи">
          <strong>${count.toLocaleString("uz-UZ")}</strong>
          <small>${done ? "ЯКУНЛАНДИ" : "САНОҚ"}</small>
          <span class="tap-hint">${done ? "" : "+1 босинг"}</span>
        </button>
      </div>
    </div>
    ${done ? `<div class="complete-banner"><span>✦</span><span><strong>Бугунги дарс бажарилди.</strong> Қолган дарслардан давом этинг.</span></div>` : `
      <div class="counter-actions">
        <button class="counter-action subtle" data-action="count-minus" data-lesson="${index}">−1</button>
        <button class="counter-action" data-action="count-ten" data-lesson="${index}">+10</button>
        <button class="counter-action" data-action="count-hundred" data-lesson="${index}">+100</button>
        <button class="counter-action subtle" data-action="count-reset" data-lesson="${index}">↺</button>
      </div>`}
    </section>
    <details class="daily-lesson-details"><summary>Дарс матни ва маъносини очиш</summary><div class="lesson-copy">${textWithBreaks(lesson.content)}</div></details>
  </article>`;
}

function renderToday() {
  syncDaily();
  document.getElementById("today-date").textContent = formatDate();
  if (lessons.length === 0) return `<div class="empty-box"><strong>Дарслар топилмади</strong><p>Қўлланма матнини қайта юкланг.</p></div>`;
  const cards = lessons.map((lesson, index) => renderCounter(lesson, index, Number(state.daily.counts[index] || 0) >= lesson.count)).join("");
  const configured = Object.values(state.schedule || {}).filter(Boolean).length;
  const completed = lessons.filter((lesson, index) => Number(state.daily.counts[index] || 0) >= lesson.count).length;
  const progress = Math.round((completed / lessons.length) * 100);
  return `<section class="home-hero">
      <div class="home-night-scene">
        <span class="hero-star star-one">✦</span><span class="hero-star star-two">·</span><span class="hero-star star-three">✧</span>
        <div class="home-crescent" aria-hidden="true"></div>
        <div class="home-arch" aria-hidden="true"><div class="home-arch-window"></div></div>
        <div class="home-copy">
          <span class="home-kicker">МАЪНАВИЙ ЙЎЛ ДАФТАРИ</span>
          <h1>Қалбингизга<br><em>қулоқ тутинг</em></h1>
          <div class="home-ornament"><span></span><b>✦</b><span></span></div>
          <p>Ҳар кун — қалбга яқинлашиш<br>учун янги қадам.</p>
        </div>
        <svg class="home-open-book" viewBox="0 0 440 150" role="img" aria-label="Очиқ китоб">
          <defs><linearGradient id="bookPage" x1="0" x2="0" y1="0" y2="1"><stop stop-color="#fff5da"/><stop offset="1" stop-color="#cba766"/></linearGradient><linearGradient id="bookCover" x1="0" x2="1"><stop stop-color="#8b5e29"/><stop offset=".5" stop-color="#e1c17b"/><stop offset="1" stop-color="#79501f"/></linearGradient></defs>
          <path d="M29 39 Q104 9 216 47 L220 128 Q115 91 32 119 Z" fill="url(#bookCover)" stroke="#f1d58f" stroke-width="3"/>
          <path d="M411 39 Q336 9 224 47 L220 128 Q325 91 408 119 Z" fill="url(#bookCover)" stroke="#f1d58f" stroke-width="3"/>
          <path d="M39 38 Q111 16 210 51 L214 115 Q119 84 39 108 Z" fill="url(#bookPage)"/>
          <path d="M401 38 Q329 16 230 51 L226 115 Q321 84 401 108 Z" fill="url(#bookPage)"/>
          <path d="M220 48 L220 128" stroke="#6d491d" stroke-width="4"/>
          <g fill="none" stroke="#9c7742" stroke-width="1.4" opacity=".65"><path d="M63 55 Q126 36 193 59 M58 68 Q126 49 194 72 M54 81 Q124 63 196 84 M251 59 Q314 36 377 55 M247 72 Q315 49 382 68 M244 84 Q316 63 386 81"/><path d="M67 93 Q126 78 196 97 M244 97 Q314 78 373 93"/></g>
          <path d="M216 128 Q223 141 230 128" fill="none" stroke="#d0a951" stroke-width="4"/>
        </svg>
        <div class="home-horizon" aria-hidden="true"><i></i><i></i><i></i></div>
      </div>
    </section>
    <section class="home-callout">
      <div class="callout-flourish flourish-left" aria-hidden="true">❧</div><div class="callout-flourish flourish-right" aria-hidden="true">❧</div>
      <span class="callout-kicker">КУНЛИК МАШҒУЛОТ</span>
      <h2>Бугунги саҳифа</h2>
      <div class="home-ornament dark"><span></span><b>◆</b><span></span></div>
      <p>Ниятни покла, қалбни тингла.</p>
      <button class="home-start-button" data-action="jump-to-lessons">Бошлаш <span>→</span></button>
    </section>
    <section class="home-progress" aria-label="Бугунги дарслар бажарилиши">
      <div class="progress-label"><span>${completed} / ${lessons.length} дарс бажарилди</span><span>${progress}%</span></div>
      <div class="home-progress-track"><span style="width:${progress}%"></span></div>
    </section>
    <div class="daily-intro">
      <span class="eyebrow">БУГУН · ${lessons.length} ТА ДАРС</span>
      <p>Барча дарслар ҳар куни ўқилади. Ҳар бирининг саноғи ва эслатма вақтини алоҳида белгиланг.</p>
    </div>
    <div class="reminder-note">Вақт белгиланган дарсларга бот ҳар куни хабар юборади. Вақтсиз қолдирилган дарсларга эслатма келмайди.</div>
    <div class="daily-lessons" id="daily-lessons">${cards}</div>
    <section class="paper-card reminder-save-card">
      <div><span class="section-label">Эслатмалар</span><strong>${configured} та дарсга вақт белгиланган</strong><p>Ўзгаришлар шу қурилмада сақланади. Telegram ботга юбориш учун қуйидаги тугмани босинг.</p></div>
      <button class="primary-button gold wide" data-action="save-reminders">Вақтларни ботга юбориш</button>
    </section>`;
}

async function fetchPrayerMonth(monthKey) {
  if (prayerMonthCache[monthKey]) return prayerMonthCache[monthKey];
  const [year, month] = monthKey.split("-").map(Number);
  const response = await fetch(`${prayerApiBase}/api/prayer-times?year=${year}&month=${month}`);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Намоз вақтлари юкланмади.");
  if (!Array.isArray(data.rows) || data.rows.length === 0) throw new Error("Манбада бу ой учун жадвал топилмади.");
  if (data.hijri_anchor) applyHijriAnchor(data.hijri_anchor);
  prayerMonthCache[monthKey] = data;
  return data;
}

function prayerMonthDates(monthKey) {
  const [year, month] = monthKey.split("-").map(Number);
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return Array.from({ length: days }, (_, index) => `${year}-${String(month).padStart(2, "0")}-${String(index + 1).padStart(2, "0")}`);
}

function addMinutes(time, amount) {
  const [hour, minute] = time.split(":").map(Number);
  const total = (hour * 60 + minute + amount) % (24 * 60);
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

function renderPrayerShell() {
  const tabs = [
    ["today", "Бугун"],
    ["tomorrow", "Эртага"],
    ["month", "Ойлик"],
    ["hijri", "Ойлик (ҳижрий)"],
  ].map(([key, label]) => `<button class="prayer-tab ${prayerView === key ? "selected" : ""}" data-action="prayer-view" data-view="${key}">${label}</button>`).join("");
  let selector = "";
  if (prayerView === "month") {
    const year = localDay().slice(0, 4);
    selector = `<label class="prayer-month-picker"><span>Григориан ойи</span><input type="month" min="${year}-01" max="${year}-12" value="${escapeHtml(prayerMonth)}" data-action="prayer-month"></label>`;
  } else if (prayerView === "hijri") {
    const options = hijriMonthOptions();
    const currentKey = hijriMonthKey(localDay());
    if (!selectedHijriMonth || !options.some((option) => option.key === selectedHijriMonth)) selectedHijriMonth = currentKey;
    selector = `<label class="prayer-month-picker"><span>Ҳижрий ой</span><select data-action="hijri-month">${options.map((option) => `<option value="${option.key}" ${option.key === selectedHijriMonth ? "selected" : ""}>${escapeHtml(option.label)}</option>`).join("")}</select></label>`;
  }
  return `${pageIntro("ТОШКЕНТ ВАҚТИ", "Намоз вақтлари", "Бугунги, эртанги ва ойлик жадвал. Манба: Islam.uz — Тошкент шаҳри.")}
    <section class="prayer-panel"><div class="prayer-tabs">${tabs}</div>${selector}
      <div class="prayer-source-note">Бомдод — саҳарлик тугаши. Шом — ифторлик вақти. Ишроқ қуёш чиққандан тахминан 20 дақиқа кейин ҳисобланади.</div>
      <div id="prayer-results" class="prayer-results"><div class="loading-state"><div class="spinner"></div><p>Намоз вақтлари юкланмоқда…</p></div></div>
    </section>`;
}

function prayerDisplayRows(dateKeys, rowsByDate, hijriMode = false) {
  const visible = dateKeys.map((dateKey) => {
    const row = rowsByDate[dateKey];
    if (!row) return null;
    const next = rowsByDate[addDays(dateKey, 1)];
    const hijriDate = formatHijriDate(dateKey);
    const gregorianDate = new Intl.DateTimeFormat("uz-Cyrl-UZ", {
      timeZone: timezone, day: "numeric", month: "short",
    }).format(dateAtTashkentNoon(dateKey));
    const dateLabel = hijriMode
      ? `<strong>${escapeHtml(hijriDate)}</strong><small>${escapeHtml(gregorianDate)}</small>`
      : `<strong>${escapeHtml(gregorianDate)}</strong>`;
    const tahajjud = next ? `${row.isha}–${next.fajr}` : "Хуфтондан бомдодгача";
    return `<tr class="${dateKey === localDay() ? "prayer-today-row" : ""}">
      <td class="prayer-date-cell">${dateLabel}</td>
      <td>${escapeHtml(weekdayFormatter.format(dateAtTashkentNoon(dateKey)))}</td>
      <td>${escapeHtml(row.fajr)}</td><td>${escapeHtml(row.sunrise)}</td><td>${escapeHtml(addMinutes(row.sunrise, 20))}</td>
      <td>${escapeHtml(row.dhuhr)}</td><td>${escapeHtml(row.asr)}</td><td>${escapeHtml(row.maghrib)}</td><td>${escapeHtml(row.isha)}</td><td>${escapeHtml(tahajjud)}</td>
    </tr>`;
  }).filter(Boolean);
  if (!visible.length) return `<div class="empty-box"><strong>Сана топилмади</strong><p>Бу ой учун Islam.uz жадвалида маълумот йўқ.</p></div>`;
  return `<div class="prayer-table-scroll"><table class="prayer-table"><thead><tr>
    <th>Сана</th><th>Ҳафта куни</th><th>Бомдод<br><small>(саҳарлик тугаши)</small></th><th>Қуёш</th><th>Ишроқ<br><small>(+20 дақ.)</small></th>
    <th>Пешин</th><th>Аср</th><th>Шом<br><small>(ифторлик)</small></th><th>Хуфтон</th><th>Таҳажжуд<br><small>(хуфтон–кейинги бомдод)</small></th>
  </tr></thead><tbody>${visible.join("")}</tbody></table></div>`;
}

async function loadPrayerView() {
  const resultNode = document.getElementById("prayer-results");
  if (!resultNode) return;
  const year = Number(localDay().slice(0, 4));
  try {
    const anchorMonth = prayerView === "month" ? prayerMonth : monthOf(localDay());
    const anchorData = await fetchPrayerMonth(anchorMonth);
    if (route !== "prayers") return;

    if (prayerView === "hijri") {
      const options = hijriMonthOptions();
      if (!selectedHijriMonth || !options.some((option) => option.key === selectedHijriMonth)) selectedHijriMonth = hijriMonthKey(localDay());
      app.innerHTML = renderPrayerShell();
    }

    let dateKeys;
    if (prayerView === "today") dateKeys = [localDay()];
    else if (prayerView === "tomorrow") dateKeys = [addDays(localDay(), 1)];
    else if (prayerView === "month") dateKeys = prayerMonthDates(prayerMonth);
    else dateKeys = datesInHijriMonth(selectedHijriMonth);

    if (!dateKeys.length) throw new Error("Танланган ҳижрий ой жорий йил жадвалида топилмади.");
    const datesToLoad = [...dateKeys, addDays(dateKeys[dateKeys.length - 1], 1)];
    const monthKeys = [...new Set(datesToLoad
      .filter((dateKey) => Number(dateKey.slice(0, 4)) === year)
      .map(monthOf))];
    const months = await Promise.all(monthKeys.map(fetchPrayerMonth));
    const rowsByDate = {};
    for (const month of [anchorData, ...months]) {
      for (const row of month.rows) rowsByDate[row.date] = row;
    }
    if (route !== "prayers") return;
    const table = prayerDisplayRows(dateKeys, rowsByDate, prayerView === "hijri");
    const sourceMonth = prayerView === "month" ? prayerMonth : monthOf(dateKeys[0]);
    const sourceUrl = `https://islam.uz/vremyanamazov/27/${Number(sourceMonth.slice(5, 7))}`;
    const sourceLabel = prayerView === "today" ? "Бугунги Islam.uz жадвали" : "Islam.uz манба саҳифаси";
    const content = document.getElementById("prayer-results");
    if (content) content.innerHTML = `${table}<p class="prayer-attribution">${escapeHtml(sourceLabel)}: <a href="${sourceUrl}" target="_blank" rel="noopener">islam.uz</a> · Тошкент вақти (UTC+5). Ишроқ тахминий; таҳажжуд оралиғи шу кунги хуфтондан кейинги бомдодгача.</p>`;
  } catch (error) {
    if (route !== "prayers") return;
    const content = document.getElementById("prayer-results");
    if (content) content.innerHTML = `<div class="empty-box prayer-error"><strong>Намоз вақтлари ҳозир очилмади</strong><p>${escapeHtml(error.message)} API манзилини текширинг ёки Islam.uz манбасини очинг.</p><a href="https://islam.uz/prayertimes" target="_blank" rel="noopener">Islam.uz — намоз вақтлари</a></div>`;
  }
}

function memoryData(type) {
  return type === "pirs" ? pirData.chain : asmaData.names;
}

function memoryMeta(type) {
  return type === "pirs"
    ? { title: "Пирлар силсиласи", short: "Пирлар", max: 40, noun: "ҳалқа" }
    : { title: "Асмоул ҳусно", short: "Аллоҳнинг 99 исми", max: 99, noun: "исм" };
}

function memoryStore(type) {
  return state.memories[type];
}

function completedSet(type) {
  const memory = memoryStore(type);
  if (!Array.isArray(memory.completed)) memory.completed = [];
  return new Set(memory.completed);
}

function createMemorySession(type) {
  const items = memoryData(type);
  const memory = memoryStore(type);
  const done = completedSet(type);
  const quota = Math.max(1, Math.min(memory.quota || 1, items.length));
  const batch = items.map((_, index) => index).filter((index) => !done.has(index)).slice(0, quota);
  memory.session = {
    day: localDay(),
    items: batch,
    status: batch.length ? "plan" : "complete",
    studyIndex: 0,
    quiz: null,
    result: null,
  };
  saveState();
}

function getMemorySession(type) {
  const memory = memoryStore(type);
  if (!memory.completed) memory.completed = [];
  if (!memory.quota) memory.quota = type === "asma" ? 3 : 1;
  if (!memory.session || memory.session.day !== localDay()) createMemorySession(type);
  return memory.session;
}

function memoryItemName(type, item) {
  return type === "pirs" ? item.name : item.reading;
}

function memoryItemSubline(type, item) {
  return type === "pirs"
    ? item.locations.map((place) => place.label).join(" · ")
    : item.meaning;
}

function renderMemoryItem(type, index, compact = false) {
  const item = memoryData(type)[index];
  if (!item) return "";
  if (type === "pirs") {
    return `<div class="memorize-item"><span class="item-number">${item.number}</span><div class="item-detail"><strong>${escapeHtml(item.name)}</strong><small>${escapeHtml(memoryItemSubline(type, item))}</small></div></div>`;
  }
  return `<div class="memorize-item ${compact ? "compact" : ""}"><span class="item-number">${item.number}</span><div class="item-detail"><div class="arabic">${escapeHtml(item.arabic)}</div><strong>${escapeHtml(item.reading)}</strong><small>${escapeHtml(item.meaning)}</small></div></div>`;
}

function memoryTabs() {
  return `<div class="subnav" role="tablist">
    <button data-action="memory-type" data-type="pirs" class="${memoryType === "pirs" ? "selected" : ""}">40 пир</button>
    <button data-action="memory-type" data-type="asma" class="${memoryType === "asma" ? "selected" : ""}">99 исм</button>
  </div>`;
}

function renderMemoryPlan(type, meta, memory, session, remaining) {
  const all = memoryData(type);
  const batchList = session.items.map((index) => renderMemoryItem(type, index, true)).join("");
  return `${pageIntro("ЁДЛАШ ДАСТУРИ", "Ўз меъёрингизни танланг", "Қобилиятингиз ва вақтингизга мос кунлик миқдорни белгиланг. Кейин ўзингизни синаб кўринг.")}
    ${memoryTabs()}
    <section class="paper-card memory-plan">
      <div class="section-label">${escapeHtml(meta.title)}</div>
      <div class="quota-row"><div><span>Кунлик меъёр</span><strong id="quota-value">${memory.quota} та</strong></div><span>Ёдда қолгани<br><b>${memory.completed.length} / ${all.length}</b></span></div>
      <input class="quota-slider" type="range" min="1" max="${meta.max}" value="${memory.quota}" data-action="quota" aria-label="Кунлик ёдлаш миқдори">
      <div class="quota-scale"><span>1 та</span><span>${meta.max} та</span></div>
      <p class="small-note">Меъёрни ўзингиз танлайсиз. Ёддан айтиб текширишда адашган исмлар кейинги такрорлашга қолади.</p>
      <div class="section-label" style="margin-top:17px">Бугунги тўплам · ${session.items.length} ${meta.noun}</div>
      ${batchList ? `<div class="memorize-list">${batchList}</div>` : `<div class="empty-box" style="margin-top:12px"><strong>Барчаси ёдланган</strong><p>Бу рўйхатдаги барча бандлар белгиланди.</p></div>`}
      ${session.items.length ? `<div class="button-row"><button class="primary-button gold wide" data-action="memory-study">Ёдлашни бошлаш <span>→</span></button></div>` : ""}
    </section>
    ${type === "asma" ? `<p class="small-note" style="color:#b5c3b5;margin:12px 3px">Кириллча ўқилиши талаффузга ёрдамчи. Арабча талаффузни устоздан эшитиб текширинг.</p><div class="source-box">${escapeHtml(asmaData.source_note)}<br><br>${asmaData.sources.map((source) => `<a href="${escapeHtml(source.url)}" target="_blank" rel="noopener">${escapeHtml(source.label)}</a>`).join(" · ")}</div>` : ""}`;
}

function renderStudy(type, meta, session) {
  const itemIndex = session.items[session.studyIndex];
  const item = memoryData(type)[itemIndex];
  if (!item) return "";
  const isPirs = type === "pirs";
  const detail = isPirs
    ? `<div class="section-label" style="margin-top:13px">Жойлар</div><div class="meaning-line">${escapeHtml(memoryItemSubline(type, item))}</div>`
    : `<div class="arabic" style="font-size:42px;margin-top:12px">${escapeHtml(item.arabic)}</div><div class="study-reading">${escapeHtml(item.reading)}</div><div class="meaning-line">${escapeHtml(item.meaning)}</div>`;
  return `${pageIntro("ЁДЛАШ", meta.title, "Исми, ўқилиши ва маъносини бирга ўрганинг.")}
    ${memoryTabs()}
    <section class="paper-card study-card">
      <div class="study-index"><span>${session.studyIndex + 1} / ${session.items.length}</span><span>${item.number}-${isPirs ? "ҳалқа" : "исм"}</span></div>
      <h2 class="study-name">${escapeHtml(memoryItemName(type, item))}</h2>
      ${detail}
      <div class="button-row"><button class="primary-button gold wide" data-action="study-next">${session.studyIndex + 1 < session.items.length ? "Кейингиси" : "Имтиҳонга ўтиш"} <span>→</span></button></div>
    </section>`;
}

function renderExamIntro(type, meta, session) {
  return `${pageIntro("ЎЗИНГИЗНИ СИНАНГ", "Ёддан айтиб кўринг", "Жавобни очишдан олдин исмни эслаб, овоз чиқариб ёки ичингизда айтиб кўринг.")}
    ${memoryTabs()}
    <section class="paper-card study-card">
      <div class="section-label">Бугунги имтиҳон</div>
      <h2 class="study-name">${session.items.length} та ${escapeHtml(meta.noun)}</h2>
      <p class="meaning-line">${type === "asma" ? "Арабча матндан ўқилиши ва маъносини эслашга ҳаракат қилинг." : "Тартиб рақамига қараб пир исмини эслашга ҳаракат қилинг."}</p>
      <div class="button-row"><button class="primary-button gold wide" data-action="exam-self">Ёддан айтиш имтиҳони <span>→</span></button><button class="secondary-button wide" data-action="exam-choice">Вариантли тест</button></div>
    </section>`;
}

function currentQuizItem(type, quiz) {
  return memoryData(type)[quiz.items[quiz.index]];
}

function makeChoices(type, correctIndex) {
  const all = memoryData(type);
  const candidateIndexes = all.map((_, index) => index).filter((index) => index !== correctIndex);
  for (let i = candidateIndexes.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [candidateIndexes[i], candidateIndexes[j]] = [candidateIndexes[j], candidateIndexes[i]];
  }
  return [correctIndex, ...candidateIndexes.slice(0, 3)].sort(() => Math.random() - 0.5);
}

function renderQuiz(type, meta, session) {
  const quiz = session.quiz;
  const item = currentQuizItem(type, quiz);
  if (!item) return "";
  const correctIndex = quiz.items[quiz.index];
  const isPirs = type === "pirs";
  const roundLabel = quiz.round ? "ҚАЙТА ТЕКШИРУВ" : "ИМТИҲОН";
  let prompt = "";
  let answer = "";
  if (quiz.mode === "choice") {
    prompt = isPirs ? `${item.number}-ҳалқадаги пир ким?` : "Ушбу исмнинг кириллча ўқилиши қайси?";
    answer = isPirs
      ? ""
      : `<div class="arabic" style="font-size:38px">${escapeHtml(item.arabic)}</div>`;
    if (!quiz.choices) quiz.choices = makeChoices(type, correctIndex);
    if (quiz.selected === null || quiz.selected === undefined) {
      const options = quiz.choices.map((index) => {
        const candidate = memoryData(type)[index];
        const text = isPirs ? candidate.name : candidate.reading;
        return `<button class="quiz-choice" data-action="quiz-choice" data-choice="${index}">${escapeHtml(text)}</button>`;
      }).join("");
      return `${pageIntro(roundLabel, "Имтиҳон", "Тўғри жавобни белгиланг.")}${memoryTabs()}
        <section class="paper-card quiz-card"><div class="session-bar"><span>${quiz.index + 1} / ${quiz.items.length}</span><span>${quiz.correct} тўғри</span></div>
        <div class="answer-question">${answer}<strong>${escapeHtml(prompt)}</strong></div>${options}</section>`;
    }
    const correct = quiz.selected === correctIndex;
    return `${pageIntro(roundLabel, correct ? "Тўғри жавоб" : "Такрорлаш керак", "")}${memoryTabs()}
      <section class="paper-card quiz-card"><div class="session-bar"><span>${quiz.index + 1} / ${quiz.items.length}</span><span>${quiz.correct} тўғри</span></div>
      <div class="answer-question">${answer}<strong>${escapeHtml(prompt)}</strong></div>
      <div class="quiz-feedback">${correct ? "Жуда яхши." : `Тўғри жавоб: ${escapeHtml(isPirs ? item.name : item.reading)}.`}${isPirs ? "" : ` Маъноси: ${escapeHtml(item.meaning)}`}</div>
      <div class="button-row"><button class="primary-button gold wide" data-action="quiz-next">${quiz.index + 1 < quiz.items.length ? "Кейинги савол" : "Натижани кўриш"} →</button></div></section>`;
  }

  prompt = isPirs ? `${item.number}-ҳалқадаги пирнинг исмини эслаб айтинг.` : "Исмнинг ўқилиши ва маъносини ёддан айтиб кўринг.";
  answer = isPirs
    ? `<strong>${escapeHtml(item.name)}</strong><small>${escapeHtml(memoryItemSubline(type, item))}</small>`
    : `<div class="arabic">${escapeHtml(item.arabic)}</div><strong>${escapeHtml(item.reading)}</strong><small>${escapeHtml(item.meaning)}</small>`;
  return `${pageIntro(roundLabel, "Ёддан жавоб беринг", "Аввал жавобни ўзингиз айтинг, кейин жавобни очинг.")}${memoryTabs()}
    <section class="paper-card quiz-card"><div class="session-bar"><span>${quiz.index + 1} / ${quiz.items.length}</span><span>${quiz.correct} тўғри</span></div>
    <div class="answer-question">${isPirs ? `<strong>№ ${item.number}</strong>` : `<div class="arabic">${escapeHtml(item.arabic)}</div>`}<strong>${escapeHtml(prompt)}</strong></div>
    ${quiz.answerVisible ? `<div class="memorize-item"><div class="item-detail">${answer}</div></div>
      <div class="button-row"><button class="primary-button gold" data-action="quiz-self-grade" data-grade="yes">Ёддан айтдим</button><button class="secondary-button" data-action="quiz-self-grade" data-grade="no">Такрорлайман</button></div>`
      : `<button class="primary-button gold wide" data-action="quiz-reveal">Жавобни очиш</button>`}</section>`;
}

function finishQuiz(type) {
  const memory = memoryStore(type);
  const session = memory.session;
  const quiz = session.quiz;
  const misses = [...new Set(quiz.mistakes)];
  if (misses.length && quiz.round < 1) {
    quiz.round += 1;
    quiz.items = misses;
    quiz.mistakes = [];
    quiz.index = 0;
    quiz.choices = null;
    quiz.selected = null;
    quiz.answerVisible = false;
    saveState();
    render();
    return;
  }
  session.status = "result";
  session.result = { passed: misses.length === 0, misses };
  saveState();
  render();
}

function renderMemoryResult(type, meta, memory, session) {
  const result = session.result || { passed: false, misses: [] };
  const completed = memory.completed.length;
  const unresolved = result.misses.map((index) => renderMemoryItem(type, index, true)).join("");
  return `${pageIntro("ИМТИҲОН НАТИЖАСИ", result.passed ? "Бугунги меъёр бажарилди" : "Қайта такрорлаш учун", result.passed ? "Ёдлаганларингиз белгиланди. Кейинги меъёр эртага очилади." : "Адашилган бандлар кейинги уринишда яна чиқади.")}
    ${memoryTabs()}
    <section class="paper-card result-card">
      <div class="section-label">Ёдлангани</div><h2 class="study-name">${completed} / ${memoryData(type).length}</h2>
      ${result.passed ? `<div class="complete-banner"><span>✦</span><span>Бугунги ${session.items.length} та ${escapeHtml(meta.noun)} имтиҳондан ўтди.</span></div>` : `<div class="memorize-list">${unresolved}</div><div class="button-row"><button class="primary-button gold wide" data-action="memory-retry">Қайта имтиҳон қилиш</button></div>`}
      <div class="button-row"><button class="secondary-button wide" data-action="memory-plan">Режага қайтиш</button></div>
    </section>`;
}

function renderMemory() {
  document.getElementById("today-date").textContent = formatDate();
  const type = memoryType;
  const meta = memoryMeta(type);
  const memory = memoryStore(type);
  const data = memoryData(type);
  if (!memory.completed) memory.completed = [];
  const remaining = data.length - memory.completed.length;
  const session = getMemorySession(type);

  if (session.status === "study") return renderStudy(type, meta, session);
  if (session.status === "examIntro") return renderExamIntro(type, meta, session);
  if (session.status === "quiz") return renderQuiz(type, meta, session);
  if (session.status === "result") return renderMemoryResult(type, meta, memory, session);
  if (session.status === "complete" || remaining <= 0) {
    return `${pageIntro("ЁДЛАШ ДАСТУРИ", "Рўйхат якунланди", "Барча бандлар ёдланган деб белгиланди.")}${memoryTabs()}<div class="empty-box"><strong>${escapeHtml(meta.title)}</strong><p>${data.length} / ${data.length} та банд бажарилди.</p></div>`;
  }
  return renderMemoryPlan(type, meta, memory, session, remaining);
}

function renderPersonList() {
  const rows = pirData.chain.map((person, index) => `
    <button class="person-row ${index === selectedPerson ? "selected" : ""}" data-action="select-person" data-person="${index}">
      <span class="item-number">${person.number}</span><span><strong>${escapeHtml(person.name)}</strong><small>${escapeHtml(person.locations.map((point) => point.label).join(" · "))}</small></span><span class="chevron">›</span>
    </button>`).join("");
  const continuation = pirData.continuation;
  return `${rows}
    <button class="person-row ${selectedPerson === 40 ? "selected" : ""}" data-action="select-person" data-person="40">
      <span class="item-number">41</span><span><strong>${escapeHtml(continuation.name)}</strong><small>${escapeHtml(continuation.locations.map((point) => point.label).join(" · "))}</small></span><span class="chevron">›</span>
    </button>`;
}

function renderPlaces() {
  document.getElementById("today-date").textContent = formatDate();
  const selected = selectedPerson === 40 ? pirData.continuation : pirData.chain[selectedPerson];
  const places = selected?.locations || [];
  return `${pageIntro("СИЛСИЛА ХАРИТАСИ", "40 пирнинг кетма-кетлиги", "Харитада рақамни босинг ёки пастдаги рўйхатдан пирни танланг.")}
    <div class="chain-summary"><div><strong>Ҳолидия–Нақшбандия силсиласи</strong><br><span>Устоз-шогирд кетма-кетлиги: 1 дан 40 гача</span></div><span class="chain-count">1 → 40</span></div>
    <section class="map-card">
      <div class="map-top"><strong>40 пир — кетма-кет харита</strong><span>1–40</span></div>
      <div id="map" role="application" aria-label="Силсила жойлари харитаси"></div>
      <div class="map-selected"><h3>${selected ? `${selected.number || 41}. ${escapeHtml(selected.name)}` : "Пирни танланг"}</h3><div class="location-pills">${places.map((place, index) => `<button class="location-pill" data-action="select-place" data-place="${index}">${escapeHtml(place.label)}</button>`).join("")}</div>
      <div class="button-row"><a class="secondary-button" href="https://www.openstreetmap.org/?mlat=${places[selectedPlace]?.lat || places[0]?.lat || 39}&mlon=${places[selectedPlace]?.lon || places[0]?.lon || 65}#map=5/${places[selectedPlace]?.lat || places[0]?.lat || 39}/${places[selectedPlace]?.lon || places[0]?.lon || 65}" target="_blank" rel="noopener">Харитани катта очиш ↗</a></div></div>
      <div class="map-note">Чизиқ силсиладаги устоз-шогирд тартибини кўрсатади, аниқ сафар йўлини эмас. Ҳар бир рақам пир учун берилган асосий тахминий жойга қўйилган; бошқа жойлари пастдаги рўйхатда бор. ${escapeHtml(pirData.source_note)}</div>
    </section>
    <div class="person-list">${renderPersonList()}</div>
    <div class="source-box"><strong>Манбалар</strong><br>${pirData.sources.map((source) => `<a href="${escapeHtml(source.url)}" target="_blank" rel="noopener">${escapeHtml(source.label)}</a>`).join(" · ")}<br><br>41-нуқта силсиладаги 40 ҳалқага қўшилмаган; алоҳида давом сифатида берилган.</div>`;
}

function addMap() {
  const mapNode = document.getElementById("map");
  if (!mapNode || !window.L) return;
  const chain = pirData.chain || [];
  const routePoints = chain
    .map((person) => ({ person, place: person.locations?.[0] }))
    .filter((item) => item.place && Number.isFinite(item.place.lat) && Number.isFinite(item.place.lon));
  leafletMap = L.map(mapNode, { zoomControl: false, scrollWheelZoom: false, preferCanvas: true }).setView([39, 63], 3);
  L.control.zoom({ position: "bottomright" }).addTo(leafletMap);

  const mapKey = document.querySelector("meta[name='maptiler-api-key']")?.content?.trim();
  if (mapKey && window.L.maptiler?.maptilerLayer) {
    L.maptiler.maptilerLayer({
      apiKey: mapKey,
      style: L.maptiler.MapStyle.STREETS,
      language: L.maptiler.Language.RUSSIAN,
    }).addTo(leafletMap);
  } else {
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 18,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(leafletMap);
  }

  const routeCoords = routePoints.map(({ place }) => [place.lat, place.lon]);
  if (routeCoords.length > 1) {
    L.polyline(routeCoords, {
      color: "#bd9554",
      weight: 3,
      opacity: 0.88,
      dashArray: "8 8",
      lineCap: "round",
      lineJoin: "round",
    }).addTo(leafletMap);
  }

  const formatPirRanges = (numbers) => {
    const sorted = [...new Set(numbers)].sort((a, b) => a - b);
    const ranges = [];
    for (const number of sorted) {
      const last = ranges[ranges.length - 1];
      if (last && number === last[1] + 1) last[1] = number;
      else ranges.push([number, number]);
    }
    return ranges.map(([start, end]) => start === end ? `${start}` : `${start}–${end}`).join(", ");
  };
  const markerGroup = window.L.markerClusterGroup
    ? L.markerClusterGroup({
        maxClusterRadius: 28,
        showCoverageOnHover: false,
        spiderfyOnMaxZoom: true,
        zoomToBoundsOnClick: true,
        iconCreateFunction: (cluster) => {
          const numbers = cluster.getAllChildMarkers()
            .map((marker) => marker.options.pirNumber)
            .filter(Number.isFinite);
          const label = formatPirRanges(numbers) || `${cluster.getChildCount()}`;
          const width = Math.max(42, Math.min(132, 22 + label.length * 7));
          return L.divIcon({
            className: "pir-map-cluster-host",
            html: `<span class="pir-map-cluster" title="Пирлар: ${label}">${label}</span>`,
            iconSize: [width, 42],
            iconAnchor: [width / 2, 21],
          });
        },
      })
    : null;
  const bounds = [];
  routePoints.forEach(({ person, place }, index) => {
    const isSelected = selectedPerson === index;
    const marker = L.marker([place.lat, place.lon], {
      pirNumber: person.number,
      icon: L.divIcon({
        className: `pir-map-marker-host${isSelected ? " selected" : ""}`,
        html: `<span class="pir-map-number">${person.number}</span>`,
        iconSize: [32, 32],
        iconAnchor: [16, 16],
      }),
      title: `${person.number}. ${person.name} — ${place.label}`,
      riseOnHover: true,
    });
    const otherPlaces = (person.locations || []).slice(1).map((item) => escapeHtml(item.label));
    const otherPlacesText = otherPlaces.length ? `<br><small>Бошқа жойлар: ${otherPlaces.join(" · ")}</small>` : "";
    marker.bindPopup(`<strong>${person.number}. ${escapeHtml(person.name)}</strong><br>${escapeHtml(place.label)}<br><small>Асосий тахминий жой</small>${otherPlacesText}`);
    if (markerGroup) markerGroup.addLayer(marker);
    else marker.addTo(leafletMap);
    bounds.push([place.lat, place.lon]);
  });
  if (markerGroup) leafletMap.addLayer(markerGroup);
  if (bounds.length > 1) leafletMap.fitBounds(bounds, { padding: [30, 30], maxZoom: 4 });
  else if (bounds.length === 1) leafletMap.setView(bounds[0], 7);
  setTimeout(() => leafletMap?.invalidateSize(), 100);
}

function renderGuide() {
  document.getElementById("today-date").textContent = formatDate();
  if (selectedLesson !== null) {
    const lesson = lessons[selectedLesson];
    return `${pageIntro("ҚЎЛЛАНМА", "Дарсни ўқиш", "Матн манбада берилган мазмун асосида кўрсатилган.")}
      <article class="paper-card guide-detail"><div class="lesson-topline"><span class="section-label">${String(selectedLesson + 1).padStart(2, "0")}</span><span class="step-pill">${lesson.count} марта</span></div><h2 class="lesson-title">${escapeHtml(lesson.title)}</h2><div class="lesson-copy">${textWithBreaks(lesson.content)}</div>
      <div class="button-row"><button class="primary-button" data-action="go-today">Бугунги вирдга қайтиш</button><button class="secondary-button" data-action="guide-back">Рўйхат</button></div></article>`;
  }
  const rows = lessons.map((lesson, index) => `<button class="guide-row" data-action="open-lesson" data-lesson="${index}"><span class="guide-num">${String(index + 1).padStart(2, "0")}</span><span><strong>${escapeHtml(lesson.title)}</strong><small>${lesson.count.toLocaleString("uz-UZ")} марта · ${Number(state.daily?.counts?.[index] || 0) >= lesson.count ? "бугун бажарилди" : "ҳар куни ўқилади"}</small></span></button>`).join("");
  return `${pageIntro("ҚЎЛЛАНМА", "9 та кунлик дарс", "Барча дарслар ҳар куни ўқилади. Исталганини очиб, матнини ўқинг.")}<div class="guide-list">${rows}</div>
    <div class="source-box">Вирд матни берилган қўлланма асосида киритилган. Қўшимча изоҳлар кейин босқичма-босқич қўшилади.</div>`;
}

function render(keepScroll = false) {
  const previousScroll = window.scrollY;
  document.body.classList.toggle("home-mode", route === "today");
  if (leafletMap) {
    leafletMap.remove();
    leafletMap = null;
  }
  updateNav();
  if (route === "today") app.innerHTML = renderToday();
  else if (route === "prayers") {
    app.innerHTML = renderPrayerShell();
    loadPrayerView();
  }
  else if (route === "memory") app.innerHTML = renderMemory();
  else if (route === "places") app.innerHTML = renderPlaces();
  else app.innerHTML = renderGuide();
  if (route === "places") requestAnimationFrame(addMap);
  window.scrollTo({ top: keepScroll ? previousScroll : 0, behavior: "smooth" });
}

function addCompleted(type, index) {
  const memory = memoryStore(type);
  if (!memory.completed.includes(index)) memory.completed.push(index);
}

function startExam(mode) {
  const session = getMemorySession(memoryType);
  session.status = "quiz";
  session.quiz = {
    mode,
    items: [...session.items],
    index: 0,
    round: 0,
    correct: 0,
    mistakes: [],
    answerVisible: false,
    choices: null,
    selected: null,
  };
  saveState();
  render();
}

function advanceQuizItem() {
  const session = getMemorySession(memoryType);
  const quiz = session.quiz;
  quiz.index += 1;
  quiz.answerVisible = false;
  quiz.choices = null;
  quiz.selected = null;
  if (quiz.index >= quiz.items.length) finishQuiz(memoryType);
  else {
    saveState();
    render(true);
  }
}

function answerChoice(choiceIndex) {
  const session = getMemorySession(memoryType);
  const quiz = session.quiz;
  const itemIndex = quiz.items[quiz.index];
  const correct = choiceIndex === itemIndex;
  quiz.selected = choiceIndex;
  if (correct) {
    quiz.correct += 1;
    addCompleted(memoryType, itemIndex);
  } else {
    quiz.mistakes.push(itemIndex);
  }
  saveState();
  render(true);
}

function setQuota(value) {
  const meta = memoryMeta(memoryType);
  const memory = memoryStore(memoryType);
  memory.quota = Math.max(1, Math.min(meta.max, Number(value) || 1));
  if (!memory.session || memory.session.status === "plan" || memory.session.status === "result") createMemorySession(memoryType);
  saveState();
  render(true);
}

function sendReminderTimes() {
  const times = Object.fromEntries(
    Object.entries(state.schedule || {}).filter(([index, value]) => Number.isInteger(Number(index)) && value),
  );
  const payload = JSON.stringify({ type: "reminders", times });
  saveState();
  if (telegramApp && typeof telegramApp.sendData === "function") {
    try {
      telegramApp.sendData(payload);
      showToast("Вақтлар Telegram ботига юборилди.");
      return;
    } catch (_) {
      // The method works only when the Mini App was opened from a reply-keyboard button.
    }
  }
  showToast("Ботга юбориш учун иловадаги «Вирд вақтларини белгилаш» тугмаси орқали очинг.");
}

app.addEventListener("click", (event) => {
  const button = event.target.closest("[data-action]");
  if (!button) return;
  const action = button.dataset.action;

  if (action === "prayer-view") {
    prayerView = button.dataset.view;
    render();
  } else if (action === "jump-to-lessons") {
    document.getElementById("daily-lessons")?.scrollIntoView({ behavior: "smooth", block: "start" });
  } else if (action === "count-one" || action === "count-ten" || action === "count-hundred" || action === "count-minus") {
    const index = Number(button.dataset.lesson);
    const lesson = lessons[index];
    if (!lesson) return;
    const amount = action === "count-one" ? 1 : action === "count-ten" ? 10 : action === "count-hundred" ? 100 : -1;
    const previous = Number(state.daily.counts[index] || 0);
    const count = Math.max(0, Math.min(lesson.count, previous + amount));
    state.daily.counts[index] = count;
    if (count >= lesson.count && previous < lesson.count) {
      showToast(`${lesson.title}: бугунги саноқ бажарилди.`);
    }
    saveState();
    render(true);
  } else if (action === "count-reset") {
    const index = Number(button.dataset.lesson);
    if (!lessons[index]) return;
    state.daily.counts[index] = 0;
    saveState();
    render(true);
  } else if (action === "save-reminders") {
    sendReminderTimes();
  } else if (action === "memory-type") {
    memoryType = button.dataset.type;
    render();
  } else if (action === "memory-study") {
    const session = getMemorySession(memoryType);
    session.status = "study";
    session.studyIndex = 0;
    saveState();
    render(true);
  } else if (action === "study-next") {
    const session = getMemorySession(memoryType);
    if (session.studyIndex + 1 < session.items.length) session.studyIndex += 1;
    else session.status = "examIntro";
    saveState();
    render(true);
  } else if (action === "exam-self") startExam("self");
  else if (action === "exam-choice") startExam("choice");
  else if (action === "quiz-reveal") {
    const session = getMemorySession(memoryType);
    session.quiz.answerVisible = true;
    render(true);
  } else if (action === "quiz-self-grade") {
    const session = getMemorySession(memoryType);
    const quiz = session.quiz;
    const itemIndex = quiz.items[quiz.index];
    if (button.dataset.grade === "yes") {
      quiz.correct += 1;
      addCompleted(memoryType, itemIndex);
    } else quiz.mistakes.push(itemIndex);
    advanceQuizItem();
  } else if (action === "quiz-choice") answerChoice(Number(button.dataset.choice));
  else if (action === "quiz-next") advanceQuizItem();
  else if (action === "memory-retry") {
    const session = getMemorySession(memoryType);
    session.items = session.items.filter((index) => !memoryStore(memoryType).completed.includes(index));
    session.status = "examIntro";
    session.result = null;
    saveState();
    render(true);
  } else if (action === "memory-plan") {
    createMemorySession(memoryType);
    render();
  } else if (action === "select-person") {
    selectedPerson = Number(button.dataset.person);
    selectedPlace = 0;
    render(true);
  } else if (action === "select-place") {
    selectedPlace = Number(button.dataset.place);
    render(true);
  } else if (action === "open-lesson") {
    selectedLesson = Number(button.dataset.lesson);
    render();
  } else if (action === "guide-back") {
    selectedLesson = null;
    render();
  } else if (action === "go-today") {
    selectedLesson = null;
    route = "today";
    render();
  }
});

app.addEventListener("change", (event) => {
  if (event.target.matches("[data-action='quota']")) setQuota(event.target.value);
  else if (event.target.matches("[data-action='prayer-month']")) {
    prayerMonth = event.target.value || localDay().slice(0, 7);
    render();
  } else if (event.target.matches("[data-action='hijri-month']")) {
    selectedHijriMonth = event.target.value;
    render();
  }
  else if (event.target.matches("[data-action='reminder-time']")) {
    const index = Number(event.target.dataset.lesson);
    if (!lessons[index]) return;
    if (event.target.value) state.schedule[index] = event.target.value;
    else delete state.schedule[index];
    saveState();
    render(true);
  }
});

navButtons.forEach((button) => {
  button.addEventListener("click", () => {
    route = button.dataset.route;
    if (route === "guide") selectedLesson = null;
    render();
  });
});

async function boot() {
  try {
    const [lessonResponse, pirsResponse, asmaResponse] = await Promise.all([
      fetch("lessons.json"),
      fetch("pirs.json"),
      fetch("asma_ul_husna.json"),
    ]);
    if (!lessonResponse.ok || !pirsResponse.ok || !asmaResponse.ok) throw new Error("Маълумот файллари очилмади.");
    lessons = await lessonResponse.json();
    pirData = await pirsResponse.json();
    asmaData = await asmaResponse.json();
    state = loadState();
    syncDaily();
    if (telegramApp) {
      telegramApp.ready();
      telegramApp.expand();
      try { telegramApp.setHeaderColor("#102c29"); telegramApp.setBackgroundColor("#102c29"); } catch (_) {}
    }
    render();
  } catch (error) {
    app.innerHTML = `<div class="empty-box"><strong>Илова очилмади</strong><p>${escapeHtml(error.message)} HTTPS манзилдан қайта очиб кўринг.</p></div>`;
  }
}

boot();
