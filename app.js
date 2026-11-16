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
let nasihatData = [];
let activeNasihatIndex = 0;
let state;
let route = "tariqat";
let prayerView = "today";
let prayerMonth = localDay().slice(0, 7);
let selectedHijriMonth = "";
let hijriDateShiftDays = 0;
let prayerMonthCache = {};
let memoryType = "pirs";
let selectedPerson = 0;
let selectedPlace = 0;
let focusPirMapSelection = false;
let selectedLesson = null;
let leafletMap = null;
let toastTimer;
let pendingSyncPromise = null;
let lastTrackedRoute = null;

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
    completedStages: [],
    sync: { consented: false, dismissed: false, pending: [] },
    memories: {
      pirs: { quota: 1, method: "stages", completed: [], session: null },
      asma: { quota: 3, method: "stages", completed: [], session: null },
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
        sync: {
          ...base.sync,
          ...(saved.sync || {}),
          pending: Array.isArray(saved.sync?.pending) ? saved.sync.pending : [],
        },
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

async function webApi(path, method = "GET", payload) {
  if (!telegramApp?.initData) throw new Error("Telegram профили орқали очинг.");
  const options = {
    method,
    headers: {
      "X-Telegram-Init-Data": telegramApp.initData,
    },
  };
  if (payload !== undefined) {
    options.headers["Content-Type"] = "application/json";
    options.body = JSON.stringify(payload);
  }
  const response = await fetch(`${prayerApiBase}${path}`, options);
  let result = {};
  try { result = await response.json(); } catch (_) {}
  if (!response.ok) {
    const error = new Error(result.error || "Серверга уланиб бўлмади.");
    error.status = response.status;
    throw error;
  }
  return result;
}

function revokeLocalSync() {
  state.sync.consented = false;
  state.sync.dismissed = false;
  state.sync.pending = [];
  state.daily = { day: localDay(), counts: {} };
  state.completedStages = [];
  state.memories = emptyState().memories;
  lastTrackedRoute = null;
  saveState();
  render(true);
}

function newOperationId() {
  if (window.crypto?.randomUUID) return window.crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2, 14)}`;
}

async function flushPendingProgress() {
  if (!telegramApp?.initData || !state.sync?.consented) return;
  if (pendingSyncPromise) return pendingSyncPromise;
  pendingSyncPromise = (async () => {
    const today = localDay();
    state.sync.pending = state.sync.pending.filter((item) => item.day === today);
    for (const item of [...state.sync.pending]) {
      try {
        const endpoint = item.reset ? "/api/progress/reset" : "/api/progress/change";
        const result = await webApi(endpoint, "POST", item);
        state.daily.counts[result.stage] = result.count;
        state.sync.pending = state.sync.pending.filter((pending) => pending.operation_id !== item.operation_id);
        saveState();
      } catch (error) {
        if (error.status === 403) revokeLocalSync();
        break;
      }
    }
  })();
  try {
    await pendingSyncPromise;
  } finally {
    pendingSyncPromise = null;
  }
}

async function syncProgressOnOpen() {
  let remote = await webApi("/api/progress");
  if (remote.needs_import) {
    const localCounts = state.daily?.day === remote.day ? { ...state.daily.counts } : {};
    await flushPendingProgress();
    if (state.sync.pending.length) return;
    remote = await webApi("/api/progress/import", "POST", { day: remote.day, counts: localCounts });
  } else {
    await flushPendingProgress();
    remote = await webApi("/api/progress");
  }
  state.daily = {
    day: remote.day,
    counts: Object.fromEntries(remote.counts.map((count, index) => [index, Number(count || 0)])),
  };
  saveState();
  await flushPendingProgress();
}

async function enableProgressSync(button) {
  if (button) button.disabled = true;
  try {
    await webApi("/api/progress/consent", "POST", {});
    state.sync.consented = true;
    state.sync.dismissed = false;
    saveState();
    await syncProgressOnOpen();
    showToast("Профилингиз очилди, саноқлар синхронланди.");
    render(true);
  } catch (error) {
    showToast(error.message || "Синхронлашни ҳозир ёқиб бўлмади.");
    if (button) button.disabled = false;
  }
}

function queueProgressChange(index, amount, reset = false) {
  const lesson = lessons[index];
  if (!lesson) return;
  const previous = Number(state.daily.counts[index] || 0);
  const count = reset ? 0 : Math.max(0, Math.min(lesson.count, previous + amount));
  state.daily.counts[index] = count;
  if (state.sync?.consented && telegramApp?.initData) {
    state.sync.pending.push({
      operation_id: newOperationId(),
      day: state.daily.day,
      stage: index,
      amount,
      reset,
    });
  }
  saveState();
  return { previous, count, lesson };
}

function trackSectionView() {
  const routeKey = `${localDay()}:${route}`;
  if (!telegramApp?.initData || !state.sync?.consented || lastTrackedRoute === routeKey) return;
  lastTrackedRoute = routeKey;
  webApi("/api/analytics/section", "POST", { section: route }).catch(() => {});
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
  const escaped = escapeHtml(value);
  const withVerseBlocks = escaped.replace(
    /\*\*([^\n*]+)\*\*\n\n\*\*([^\n*]+)\*\*/g,
    (match, arabic, reading) => {
      if (!/[\u0600-\u06FF]/.test(arabic)) return match;
      return `<div class="lesson-verse-block"><div class="lesson-verse-arabic" dir="rtl" lang="ar"><strong>${arabic}</strong></div><div class="lesson-verse-reading"><strong>${reading}</strong></div></div>`;
    },
  );
  return withVerseBlocks
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replaceAll("\n", "<br>");
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

function syncConsentMarkup() {
  return `<div class="sync-consent-overlay" role="presentation">
    <section class="sync-consent-card" role="dialog" aria-modal="true" aria-labelledby="sync-consent-title">
      <span class="sync-consent-icon" aria-hidden="true">☁</span>
      <span class="eyebrow">TELEGRAM ОРҚАЛИ ПРОФИЛЬ</span>
      <h2 id="sync-consent-title">Саноқларингиз бир жойда сақлансин</h2>
      <p>Telegram аккаунтингиз орқали профил автоматик очилади. Саноқларингиз бошқа қурилмада ҳам давом этади.</p>
      <p class="sync-consent-note">Админлар фақат умумий фойдаланиш статистикасини кўради. Қайси матнни ким очгани бўйича шахсий тарих сақланмайди.</p>
      <div class="button-row">
        <button class="primary-button gold wide" data-action="enable-sync">Давом этиш ва синхронлаш</button>
        <button class="secondary-button wide" data-action="later-sync">Ҳозирча локал давом этиш</button>
      </div>
    </section>
  </div>`;
}

function syncReminderMarkup() {
  return `<aside class="sync-reminder" role="status">
    <div><strong>Саноқларни Telegram’га боғлаш</strong><small>Бошқа қурилмаларда ҳам давом этинг.</small></div>
    <button class="secondary-button" data-action="enable-sync">Синхронлаш</button>
  </aside>`;
}

function renderCounter(lesson, index, done) {
  const count = Number(state.daily?.counts?.[index] || 0);
  const percent = Math.min(100, Math.round((count / lesson.count) * 100));
  return `<article class="daily-lesson-card">
    <div class="daily-lesson-heading">
      <span class="guide-num">${String(index + 1).padStart(2, "0")}</span>
      <div><h2>${escapeHtml(lesson.title)}</h2><small>${lesson.count.toLocaleString("uz-UZ")} марта · ҳар куни</small></div>
    </div>
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

function renderNasihat() {
  const item = nasihatData[activeNasihatIndex];
  if (!item) return "";
  const imageUrl = new URL(item.image, document.baseURI).href;
  const steps = item.steps.map((step, index) => `<li class="nasihat-step">
    <div class="nasihat-step-title"><span>${String(index + 1).padStart(2, "0")}</span><strong>${escapeHtml(step.term)}</strong></div>
    <p>${escapeHtml(step.meaning)}</p>
    <small><b>Мисол:</b> ${escapeHtml(step.example)}</small>
  </li>`).join("");
  return `<details class="nasihat-card">
    <summary class="nasihat-cover">
      <img class="nasihat-image" src="${escapeHtml(imageUrl)}" alt="${escapeHtml(item.pir)}" loading="eager">
      <span class="nasihat-image-shade" aria-hidden="true"></span>
      <span class="nasihat-cover-copy">
        <span class="nasihat-label">БУГУНГИ НАСИҲАТ <i>${String(activeNasihatIndex + 1).padStart(2, "0")} / ${String(nasihatData.length).padStart(2, "0")}</i></span>
        <span class="nasihat-quote">${escapeHtml(item.advice)}</span>
        <span class="nasihat-pir">— ${escapeHtml(item.pir)}</span>
        <span class="nasihat-open-hint">Маъноси ва мисолларини очиш <b>⌄</b></span>
      </span>
      <button type="button" class="nasihat-arrow nasihat-arrow-prev" data-action="nasihat-prev" aria-label="Аввалги насиҳат">←</button>
      <button type="button" class="nasihat-arrow nasihat-arrow-next" data-action="nasihat-next" aria-label="Кейинги насиҳат">→</button>
    </summary>
    <div class="nasihat-expanded">
      <span class="section-label">МАЪНОСИ</span>
      <p class="nasihat-meaning">${escapeHtml(item.meaning)}</p>
      <span class="section-label nasihat-steps-label">БОСҚИЧМА-БОСҚИЧ ЎЗЛАШТИРИШ</span>
      <ol class="nasihat-steps">${steps}</ol>
      <div class="nasihat-card-actions">
        <a class="nasihat-source" href="${escapeHtml(item.source_url)}" target="_blank" rel="noopener noreferrer">Манба ва нисбат ҳақида</a>
        <button type="button" class="nasihat-next" data-action="nasihat-next">Яна бир насиҳат <span>→</span></button>
      </div>
      <small class="nasihat-attribution">${escapeHtml(item.attribution_note)}</small>
    </div>
  </details>`;
}

function renderToday() {
  syncDaily();
  document.getElementById("today-date").textContent = formatDate();
  if (lessons.length === 0) return `<div class="empty-box"><strong>Дарслар топилмади</strong><p>Қўлланма матнини қайта юкланг.</p></div>`;
  const cards = lessons.map((lesson, index) => renderCounter(lesson, index, Number(state.daily.counts[index] || 0) >= lesson.count)).join("");
  const completed = lessons.filter((lesson, index) => Number(state.daily.counts[index] || 0) >= lesson.count).length;
  const progress = Math.round((completed / lessons.length) * 100);
  return `${renderNasihat()}<section class="home-hero">
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
      <p>Барча дарслар ҳар куни ўқилади. Ҳар бир дарснинг саноғи алоҳида сақланади.</p>
    </div>
    <div class="daily-lessons" id="daily-lessons">${cards}</div>`;
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

function prayerClockMinutes(value) {
  const match = String(value || "").match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return hour * 60 + minute;
}

function calculateTahajjud(row, nextDayRow) {
  const ishaMinutes = prayerClockMinutes(row?.isha);
  const fajrMinutes = prayerClockMinutes(nextDayRow?.fajr);
  if (ishaMinutes === null || fajrMinutes === null) {
    return { time: "—", interval: "Кейинги кунги бомдод вақти топилмади" };
  }
  const nightMinutes = (fajrMinutes - ishaMinutes + 1440) % 1440;
  if (!nightMinutes) return { time: "—", interval: "Хуфтон ва бомдод вақти текширилсин" };
  const tahajjudMinutes = (ishaMinutes + nightMinutes * 2 / 3) % 1440;
  const roundedHour = Math.floor((tahajjudMinutes + 30) / 60) % 24;
  return {
    time: `${String(roundedHour).padStart(2, "0")}:00`,
    interval: `Хуфтон ${row.isha} дан Бомдод ${nextDayRow.fajr} гача`,
  };
}

function prayerDisplayRows(dateKeys, rowsByDate, hijriMode = false, verticalMode = false) {
  const visible = dateKeys.map((dateKey) => {
    const row = rowsByDate[dateKey];
    if (!row) return null;
    const next = rowsByDate[addDays(dateKey, 1)];
    const tahajjud = calculateTahajjud(row, next);
    const hijriDate = formatHijriDate(dateKey);
    const gregorianDate = new Intl.DateTimeFormat("uz-Cyrl-UZ", {
      timeZone: timezone, day: "numeric", month: "short",
    }).format(dateAtTashkentNoon(dateKey));
    const dateLabel = hijriMode
      ? `<strong>${escapeHtml(hijriDate)}</strong><small>${escapeHtml(gregorianDate)}</small>`
      : `<strong>${escapeHtml(gregorianDate)}</strong>`;
    const weekday = weekdayFormatter.format(dateAtTashkentNoon(dateKey));
    const times = [
      { label: "Бомдод", time: row.fajr, note: "саҳарлик тугаши" },
      { label: "Қуёш", time: row.sunrise, note: "" },
      { label: "Ишроқ", time: addMinutes(row.sunrise, 20), note: "қуёш чиққандан тахминан 20 дақиқа кейин" },
      { label: "Пешин", time: row.dhuhr, note: "" },
      { label: "Аср", time: row.asr, note: "" },
      { label: "Шом", time: row.maghrib, note: "ифторлик вақти" },
      { label: "Хуфтон", time: row.isha, note: "" },
      { label: "Таҳажжуд", time: tahajjud.time, note: `${tahajjud.interval} · туннинг 2/3 қисми` },
    ];
    if (verticalMode) {
      return `<article class="prayer-day-card ${dateKey === localDay() ? "prayer-today-row" : ""}">
        <header class="prayer-day-heading"><div class="prayer-date-cell">${dateLabel}</div><span>${escapeHtml(weekday)}</span></header>
        <div class="prayer-day-times">
          <div class="prayer-day-time prayer-day-time-heading"><span>Намоз</span><span>Вақти</span><span>Изоҳ</span></div>
          ${times.map(({ label, time, note }) => `<div class="prayer-day-time"><strong>${label}</strong><time>${escapeHtml(time)}</time><small>${escapeHtml(note)}</small></div>`).join("")}
        </div>
      </article>`;
    }
    return `<tr class="${dateKey === localDay() ? "prayer-today-row" : ""}">
      <td class="prayer-date-cell">${dateLabel}</td>
      <td>${escapeHtml(weekday)}</td>
      <td>${escapeHtml(row.fajr)}</td><td>${escapeHtml(row.sunrise)}</td><td>${escapeHtml(addMinutes(row.sunrise, 20))}</td>
      <td>${escapeHtml(row.dhuhr)}</td><td>${escapeHtml(row.asr)}</td><td>${escapeHtml(row.maghrib)}</td><td>${escapeHtml(row.isha)}</td><td class="prayer-tahajjud-cell"><strong>${escapeHtml(tahajjud.time)}</strong><small>${escapeHtml(tahajjud.interval)}</small></td>
    </tr>`;
  }).filter(Boolean);
  if (!visible.length) return `<div class="empty-box"><strong>Сана топилмади</strong><p>Бу ой учун Islam.uz жадвалида маълумот йўқ.</p></div>`;
  if (verticalMode) return `<div class="prayer-day-list">${visible.join("")}</div>`;
  return `<div class="prayer-table-scroll"><table class="prayer-table"><thead><tr>
    <th>Сана</th><th>Ҳафта куни</th><th>Бомдод<br><small>(саҳарлик тугаши)</small></th><th>Қуёш</th><th>Ишроқ<br><small>(+20 дақ.)</small></th>
    <th>Пешин</th><th>Аср</th><th>Шом<br><small>(ифторлик)</small></th><th>Хуфтон</th><th>Таҳажжуд<br><small>(туннинг 2/3 қисми)</small></th>
  </tr></thead><tbody>${visible.join("")}</tbody></table></div>`;
}

async function loadPrayerView() {
  const resultNode = document.getElementById("prayer-results");
  if (!resultNode) return;
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
    const monthKeys = [...new Set(datesToLoad.map(monthOf))];
    const months = await Promise.all(monthKeys.map(fetchPrayerMonth));
    const rowsByDate = {};
    for (const month of [anchorData, ...months]) {
      for (const row of month.rows) rowsByDate[row.date] = row;
    }
    if (route !== "prayers") return;
    const table = prayerDisplayRows(dateKeys, rowsByDate, prayerView === "hijri", prayerView === "today" || prayerView === "tomorrow");
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
    ? { title: "Пирлар силсиласи", short: "Пирлар", max: pirData.chain.length, noun: "ҳалқа" }
    : { title: "Асмоул ҳусно", short: "Аллоҳнинг 99 исми", max: 99, noun: "исм" };
}

function memoryStore(type) {
  return state.memories[type];
}

function selectedMemoryMethod(type) {
  const memory = memoryStore(type);
  if (!["stages", "quota"].includes(memory.method)) memory.method = "stages";
  return memory.method;
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
  const method = selectedMemoryMethod(type);
  let batch;
  let stageNumber = null;
  if (method === "stages") {
    const nextIndex = items.findIndex((_, index) => !done.has(index));
    const stageCount = Math.ceil(items.length / 5);
    const stageStart = nextIndex < 0 ? items.length : Math.floor(nextIndex / 5) * 5;
    stageNumber = Math.min(stageCount, Math.floor(stageStart / 5) + 1);
    batch = items
      .map((_, index) => index)
      .filter((index) => index >= stageStart && index < stageStart + 5 && !done.has(index));
  } else {
    const quota = Math.max(1, Math.min(memory.quota || 1, items.length));
    batch = items.map((_, index) => index).filter((index) => !done.has(index)).slice(0, quota);
  }
  memory.session = {
    day: localDay(),
    items: batch,
    method,
    stageNumber,
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
  const desiredMethod = selectedMemoryMethod(type);
  if (!memory.session || memory.session.day !== localDay()
    || (memory.session.status === "plan" && memory.session.method !== desiredMethod)) {
    createMemorySession(type);
  }
  if (memory.session && !memory.session.method) memory.session.method = "quota";
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
  return `<div class="subnav memory-tabs" role="tablist" aria-label="Ёдлаш йўналишини танланг">
    <button data-action="memory-type" data-type="asma" role="tab" aria-selected="${memoryType === "asma"}" class="${memoryType === "asma" ? "selected" : ""}"><span class="memory-tab-title">Аллоҳнинг 99 исми</span><span class="memory-tab-caption">Асмоул ҳусно</span></button>
    <button data-action="memory-type" data-type="pirs" role="tab" aria-selected="${memoryType === "pirs"}" class="${memoryType === "pirs" ? "selected" : ""}"><span class="memory-tab-title">41 пир</span><span class="memory-tab-caption">Пирлар силсиласи</span></button>
  </div>`;
}

function memoryMethodTabs(type, selected = selectedMemoryMethod(type)) {
  const title = type === "pirs" ? "41 пирни ёдлаш усули" : "99 исмни ёдлаш усули";
  return `<div class="memory-method-heading">${title}</div>
    <div class="memory-method-tabs" role="tablist" aria-label="${title}">
      <button data-action="memory-method" data-type="${type}" data-method="quota" role="tab" aria-selected="${selected === "quota"}" class="${selected === "quota" ? "selected" : ""}"><strong>Кунлик меъёр</strong><small>Кунига ёдлайдиган исмлар сонини ўзингиз белгиланг.</small></button>
      <button data-action="memory-method" data-type="${type}" data-method="stages" role="tab" aria-selected="${selected === "stages"}" class="${selected === "stages" ? "selected" : ""}"><strong>Босқичма-босқич</strong><small>5 тадан ўрганинг, сўнг ёддан текширинг.</small></button>
    </div>`;
}

function renderStageMemoryItem(type, index, isComplete, isCurrent, queuedLabel = "Кейинги навбат") {
  const item = memoryData(type)[index];
  if (!item) return "";
  const status = isComplete ? "✓ Ёдланган" : isCurrent ? "Ҳозирги вазифа" : queuedLabel;
  return `<div class="memorize-item stage-item ${isComplete ? "is-done" : isCurrent ? "is-current" : ""}">
    <span class="item-number">${item.number}</span>
    <div class="item-detail">${type === "asma" ? `<div class="arabic">${escapeHtml(item.arabic)}</div>` : ""}<strong>${escapeHtml(memoryItemName(type, item))}</strong><small>${escapeHtml(memoryItemSubline(type, item))}</small></div>
    <span class="stage-status">${status}</span>
  </div>`;
}

function renderStageMemoryPlan(type, meta, memory, session) {
  const all = memoryData(type);
  const noun = type === "pirs" ? "пир" : "исм";
  const methodDescription = type === "pirs"
    ? "41 пир 5 тадан босқичларга бўлинган. Ҳар бир босқични ёдлаб, кейинги босқичга ўтинг."
    : "99 исм 5 тадан босқичларга бўлинган. Охирги босқичда 4 та исм бор.";
  const completed = completedSet(type);
  const stageCount = Math.ceil(all.length / 5);
  const nextIndex = all.findIndex((_, index) => !completed.has(index));
  if (nextIndex < 0) {
    return `${pageIntro("ЁДЛАШ ДАСТУРИ", `${all.length} та ${noun} ёдланди`, "Барча босқичлар якунланди. Аллоҳ қабул қилсин.")}${memoryTabs()}${memoryMethodTabs(type, "stages")}<div class="empty-box"><strong>${stageCount} / ${stageCount} босқич</strong><p>${all.length} / ${all.length} та ${noun} ёдланган деб белгиланди.</p></div>`;
  }
  const stageStart = Math.floor(nextIndex / 5) * 5;
  const stageNumber = Math.floor(stageStart / 5) + 1;
  const stageIndexes = all.map((_, index) => index).filter((index) => index >= stageStart && index < stageStart + 5);
  const stageDone = stageIndexes.filter((index) => completed.has(index)).length;
  const currentIndex = stageIndexes.find((index) => !completed.has(index));
  let rows;
  if (type === "pirs") {
    rows = Array.from({ length: stageCount }, (_, groupIndex) => {
      const groupStart = groupIndex * 5;
      const groupIndexes = all.map((_, index) => index).filter((index) => index >= groupStart && index < groupStart + 5);
      const groupDone = groupIndexes.filter((index) => completed.has(index)).length;
      const groupHeading = `<div class="stage-group-heading"><span>${groupIndex + 1}-босқич</span><b>${groupDone} / ${groupIndexes.length} ёдланган</b></div>`;
      const groupRows = groupIndexes.map((index) => renderStageMemoryItem(
        type,
        index,
        completed.has(index),
        index === nextIndex,
        index < stageStart ? "Ёдланган" : index < stageStart + 5 ? "Навбатда" : "Кейинги босқич",
      )).join("");
      return `${groupHeading}${groupRows}`;
    }).join("");
  } else {
    rows = stageIndexes.map((index) => renderStageMemoryItem(type, index, completed.has(index), index === currentIndex)).join("");
  }
  const startNumber = stageStart + 1;
  const endNumber = Math.min(stageStart + 5, all.length);
  return `${pageIntro("ЁДЛАШ ДАСТУРИ", `${all.length} та ${noun}ни босқичма-босқич ёдланг`, methodDescription)}
    ${memoryTabs()}
    ${memoryMethodTabs(type, "stages")}
    <section class="paper-card memory-plan stage-plan">
      <div class="stage-overview"><div><div class="section-label">${stageNumber}-БОСҚИЧ · ${stageCount} БОСҚИЧДАН</div><h2>№ ${startNumber}–${endNumber}</h2></div><span class="stage-count-pill">${stageIndexes.length} та ${noun}</span></div>
      <div class="quota-row stage-quota-row"><div><span>Ёдда қолгани</span><strong>${memory.completed.length} / ${all.length}</strong></div><span>${stageDone} / ${stageIndexes.length} ${noun} ёдланган</span></div>
      <div class="stage-progress" role="progressbar" aria-label="${stageNumber}-босқичдаги ёдланган ${noun}лар" aria-valuemin="0" aria-valuemax="${stageIndexes.length}" aria-valuenow="${stageDone}"><span style="width:${stageDone / stageIndexes.length * 100}%"></span></div>
      <p class="small-note stage-explainer">Аввал шу босқичдаги ${stageIndexes.length} та ${noun}ни ўрганинг. Имтиҳонда тўғри айтилганлари рўйхатда белги билан қолади; адашилганлари такрорланади.</p>
      <div class="section-label stage-list-heading">${type === "pirs" ? `ПИРЛАРНИНГ ТЎЛИҚ РЎЙХАТИ · 1–${all.length}` : `${stageNumber}-босқич рўйхати`}</div>
      <div class="memorize-list stage-list">${rows}</div>
      ${session.items.length ? `<div class="button-row"><button class="primary-button gold wide" data-action="memory-study">${stageDone ? "Қолган бандларни ёдлаш" : `${stageNumber}-босқични бошлаш`} <span>→</span></button></div>` : ""}
      <div class="stage-how"><strong>Қандай ишлайди?</strong><span>${stageIndexes.length} та ${noun}ни ўрганинг</span><b>→</b><span>ёддан текширинг</span><b>→</b><span>кейинги босқич очилади</span></div>
    </section>
    ${type === "asma" ? `<p class="small-note" style="margin:12px 3px">Кириллча ўқилиши талаффузга ёрдамчи. Арабча талаффузни устоздан эшитиб текширинг.</p><div class="source-box">${escapeHtml(asmaData.source_note)}<br><br>${asmaData.sources.map((source) => `<a href="${escapeHtml(source.url)}" target="_blank" rel="noopener">${escapeHtml(source.label)}</a>`).join(" · ")}</div>` : ""}`;
}

function renderMemoryPlan(type, meta, memory, session, remaining) {
  if (selectedMemoryMethod(type) === "stages") return renderStageMemoryPlan(type, meta, memory, session);
  const all = memoryData(type);
  const batchList = session.items.map((index) => renderMemoryItem(type, index, true)).join("");
  return `${pageIntro("ЁДЛАШ ДАСТУРИ", "Ўз меъёрингизни танланг", "Қобилиятингиз ва вақтингизга мос кунлик миқдорни белгиланг. Кейин ўзингизни синаб кўринг.")}
    ${memoryTabs()}
    ${memoryMethodTabs(type, "quota")}
    <section class="paper-card memory-plan">
      <div class="section-label">${escapeHtml(meta.title)}</div>
      <div class="quota-row"><div><span>Ёдда қолгани</span><strong>${memory.completed.length} / ${all.length}</strong></div><span>${escapeHtml(meta.short)} рўйхати</span></div>
      <label class="quota-input-row"><span><strong>Кунлик меъёр</strong><small>1 дан ${meta.max} гача сон киритинг</small></span><span class="quota-input-control"><input class="quota-input" type="number" min="1" max="${meta.max}" step="1" inputmode="numeric" value="${memory.quota}" data-action="quota" aria-label="Кунлик ёдлаш миқдори"><b>та</b></span></label>
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
    ${memoryMethodTabs(type)}
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
    ${memoryMethodTabs(type)}
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
      return `${pageIntro(roundLabel, "Имтиҳон", "Тўғри жавобни белгиланг.")}${memoryTabs()}${memoryMethodTabs(type)}
        <section class="paper-card quiz-card"><div class="session-bar"><span>${quiz.index + 1} / ${quiz.items.length}</span><span>${quiz.correct} тўғри</span></div>
        <div class="answer-question">${answer}<strong>${escapeHtml(prompt)}</strong></div>${options}</section>`;
    }
    const correct = quiz.selected === correctIndex;
    return `${pageIntro(roundLabel, correct ? "Тўғри жавоб" : "Такрорлаш керак", "")}${memoryTabs()}${memoryMethodTabs(type)}
      <section class="paper-card quiz-card"><div class="session-bar"><span>${quiz.index + 1} / ${quiz.items.length}</span><span>${quiz.correct} тўғри</span></div>
      <div class="answer-question">${answer}<strong>${escapeHtml(prompt)}</strong></div>
      <div class="quiz-feedback">${correct ? "Жуда яхши." : `Тўғри жавоб: ${escapeHtml(isPirs ? item.name : item.reading)}.`}${isPirs ? "" : ` Маъноси: ${escapeHtml(item.meaning)}`}</div>
      <div class="button-row"><button class="primary-button gold wide" data-action="quiz-next">${quiz.index + 1 < quiz.items.length ? "Кейинги савол" : "Натижани кўриш"} →</button></div></section>`;
  }

  prompt = isPirs ? `${item.number}-ҳалқадаги пирнинг исмини эслаб айтинг.` : "Исмнинг ўқилиши ва маъносини ёддан айтиб кўринг.";
  answer = isPirs
    ? `<strong>${escapeHtml(item.name)}</strong><small>${escapeHtml(memoryItemSubline(type, item))}</small>`
    : `<div class="arabic">${escapeHtml(item.arabic)}</div><strong>${escapeHtml(item.reading)}</strong><small>${escapeHtml(item.meaning)}</small>`;
  return `${pageIntro(roundLabel, "Ёддан жавоб беринг", "Аввал жавобни ўзингиз айтинг, кейин жавобни очинг.")}${memoryTabs()}${memoryMethodTabs(type)}
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
  const stageMethod = session.method === "stages";
  const passedTitle = stageMethod ? "Босқич бажарилди" : "Бугунги меъёр бажарилди";
  const passedCopy = stageMethod
    ? (completed >= memoryData(type).length ? "Барча босқичлар якунланди. Аллоҳ қабул қилсин." : "Ёдланганлар рўйхатда белгиланди. Кейинги босқичга ўтиб давом этинг.")
    : "Ёдлаганларингиз белгиланди. Кейинги меъёр эртага очилади.";
  return `${pageIntro("ИМТИҲОН НАТИЖАСИ", result.passed ? passedTitle : "Қайта такрорлаш учун", result.passed ? passedCopy : "Адашилган бандлар кейинги уринишда яна чиқади.")}
    ${memoryTabs()}
    ${memoryMethodTabs(type)}
    <section class="paper-card result-card">
      <div class="section-label">Ёдлангани</div><h2 class="study-name">${completed} / ${memoryData(type).length}</h2>
      ${result.passed ? `<div class="complete-banner"><span>✦</span><span>${stageMethod ? `${session.stageNumber || "Кейинги"}-босқичдаги` : "Бугунги"} ${session.items.length} та ${escapeHtml(meta.noun)} имтиҳондан ўтди.</span></div>` : `<div class="memorize-list">${unresolved}</div><div class="button-row"><button class="primary-button gold wide" data-action="memory-retry">Қайта имтиҳон қилиш</button></div>`}
      <div class="button-row"><button class="secondary-button wide" data-action="memory-plan">${stageMethod && result.passed && completed < memoryData(type).length ? "Кейинги босқичга ўтиш" : "Режага қайтиш"}</button></div>
    </section>`;
}

function renderAsmaIndex(session) {
  const names = asmaData.names;
  const completed = completedSet("asma");
  const activeIndex = session.status === "quiz" && session.quiz
    ? session.quiz.items[session.quiz.index]
    : session.items[session.studyIndex] ?? names.findIndex((_, index) => !completed.has(index));
  const rows = names.map((item, index) => {
    const isDone = completed.has(index);
    const isActive = index === activeIndex;
    const status = isDone ? "✓ Ёдланган" : isActive ? "Ҳозирги" : "Танлаш учун босинг";
    return `<button class="asma-index-row ${isDone ? "is-done" : ""} ${isActive ? "is-active" : ""}" data-action="asma-select" data-index="${index}" aria-current="${isActive ? "true" : "false"}"><span class="asma-index-number">${String(item.number).padStart(2, "0")}</span><span class="asma-index-copy"><strong>${escapeHtml(item.reading)}</strong><small>${status}</small></span>${isDone ? `<span class="asma-check" aria-label="Ёдланган">✓</span>` : ""}</button>`;
  }).join("");
  return `<aside class="asma-index paper-card" aria-label="Аллоҳнинг 99 исми рўйхати"><div class="asma-index-head"><div><span class="section-label">Доимий рўйхат</span><h2>99 исм</h2></div><span class="asma-total">${completed.size} / ${names.length}</span></div><div class="asma-index-progress" role="progressbar" aria-label="Ёдланган исмлар" aria-valuemin="0" aria-valuemax="${names.length}" aria-valuenow="${completed.size}"><span style="width:${completed.size / names.length * 100}%"></span></div><div class="asma-index-list">${rows}</div><p class="asma-index-foot">✓ белгиси — ёдланган исм</p></aside>`;
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
  let content;
  if (session.status === "study") content = renderStudy(type, meta, session);
  else if (session.status === "examIntro") content = renderExamIntro(type, meta, session);
  else if (session.status === "quiz") content = renderQuiz(type, meta, session);
  else if (session.status === "result") content = renderMemoryResult(type, meta, memory, session);
  else if (session.status === "complete" || remaining <= 0) {
    const stageCount = Math.ceil(data.length / 5);
    const stageCopy = selectedMemoryMethod(type) === "stages" ? `<div class="section-label">${stageCount} / ${stageCount} босқич</div>` : "";
    content = `${pageIntro("ЁДЛАШ ДАСТУРИ", "Рўйхат якунланди", "Барча бандлар ёдланган деб белгиланди.")}${memoryTabs()}${memoryMethodTabs(type)}<div class="empty-box">${stageCopy}<strong>${escapeHtml(meta.title)}</strong><p>${data.length} / ${data.length} та банд бажарилди.</p></div>`;
  } else content = renderMemoryPlan(type, meta, memory, session, remaining);
  return type === "asma" ? `<div class="asma-dashboard">${renderAsmaIndex(session)}<div class="asma-learning">${content}</div></div>` : content;
}

function renderPersonList() {
  const rows = pirData.chain.map((person, index) => `
    <button class="person-row ${index === selectedPerson ? "selected" : ""}" data-action="select-person" data-person="${index}">
      <span class="item-number">${person.number}</span><span><strong>${escapeHtml(person.name)}</strong><small>${escapeHtml(person.locations.map((point) => point.label).join(" · "))}</small></span><span class="chevron">›</span>
    </button>`).join("");
  return rows;
}

function renderPlaces() {
  document.getElementById("today-date").textContent = formatDate();
  const selected = pirData.chain[selectedPerson];
  const places = selected?.locations || [];
  const pirCount = pirData.chain.length;
  return `${pageIntro("СИЛСИЛА ХАРИТАСИ", `${pirCount} пирнинг кетма-кетлиги`, "Харитада рақамни босинг ёки пастдаги рўйхатдан пирни танланг.")}
    <div class="chain-summary"><div><strong>Ҳожагон–Нақшбандия силсиласи</strong><br><span>Устоз-шогирд кетма-кетлиги: 1 дан ${pirCount} гача</span></div><span class="chain-count">1 → ${pirCount}</span></div>
    <section class="map-card">
      <div class="map-top"><strong>${pirCount} пир — кетма-кет харита</strong><span>1–${pirCount}</span></div>
      <div id="map" role="application" aria-label="Силсила жойлари харитаси"></div>
      <div class="map-selected"><h3>${selected ? `${selected.number || 41}. ${escapeHtml(selected.name)}` : "Пирни танланг"}</h3><div class="location-pills">${places.map((place, index) => `<button class="location-pill" data-action="select-place" data-place="${index}">${escapeHtml(place.label)}</button>`).join("")}</div>
      <div class="button-row"><a class="secondary-button" href="https://www.openstreetmap.org/?mlat=${places[selectedPlace]?.lat || places[0]?.lat || 39}&mlon=${places[selectedPlace]?.lon || places[0]?.lon || 65}#map=5/${places[selectedPlace]?.lat || places[0]?.lat || 39}/${places[selectedPlace]?.lon || places[0]?.lon || 65}" target="_blank" rel="noopener">Харитани катта очиш ↗</a></div></div>
      <div class="map-note">Чизиқ силсиладаги устоз-шогирд тартибини кўрсатади, аниқ сафар йўлини эмас. Ҳар бир рақам пир учун берилган асосий тахминий жойга қўйилган; бошқа жойлари пастдаги рўйхатда бор. ${escapeHtml(pirData.source_note)}</div>
    </section>
    <div class="person-list">${renderPersonList()}</div>
    <div class="source-box"><strong>Манбалар</strong><br>${pirData.sources.map((source) => `<a href="${escapeHtml(source.url)}" target="_blank" rel="noopener">${escapeHtml(source.label)}</a>`).join(" · ")}<br><br>Пирлар тартиби сиз юборган «Силсилаи Шариф» рўйхати асосида кўрсатилди.</div>`;
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
  const markerLayer = L.layerGroup().addTo(leafletMap);
  const renderNumberedMarkers = () => {
    markerLayer.clearLayers();
    const zoom = leafletMap.getZoom();
    const projected = routePoints.map((item) => ({
      ...item,
      point: leafletMap.project([item.place.lat, item.place.lon], zoom),
    }));
    const parents = projected.map((_, index) => index);
    const findRoot = (index) => {
      while (parents[index] !== index) {
        parents[index] = parents[parents[index]];
        index = parents[index];
      }
      return index;
    };
    for (let i = 0; i < projected.length; i += 1) {
      for (let j = i + 1; j < projected.length; j += 1) {
        if (projected[i].point.distanceTo(projected[j].point) <= 34) {
          const rootI = findRoot(i);
          const rootJ = findRoot(j);
          if (rootI !== rootJ) parents[rootJ] = rootI;
        }
      }
    }
    const groups = new Map();
    projected.forEach((item, index) => {
      const root = findRoot(index);
      if (!groups.has(root)) groups.set(root, []);
      groups.get(root).push(item);
    });
    groups.forEach((items) => {
      const numbers = items.map(({ person }) => person.number);
      const label = formatPirRanges(numbers);
      const lat = items.reduce((sum, item) => sum + item.place.lat, 0) / items.length;
      const lon = items.reduce((sum, item) => sum + item.place.lon, 0) / items.length;
      const isSelected = items.some(({ person }) => selectedPerson === person.number - 1);
      const marker = L.circleMarker([lat, lon], {
        radius: items.length > 1 ? 13 : 11,
        color: isSelected ? "#102c29" : "#f8edcf",
        weight: 2,
        fillColor: isSelected ? "#e0bd70" : items.length > 1 ? "#e0bd70" : "#0d3b2d",
        fillOpacity: 1,
        opacity: 1,
      }).addTo(markerLayer);
      marker.bindTooltip(label, {
        permanent: true,
        direction: "center",
        className: "pir-number-tooltip",
        opacity: 1,
      });
      marker.bindPopup(items.map(({ person, place }) =>
        `<div><strong>${person.number}. ${escapeHtml(person.name)}</strong><br>${escapeHtml(place.label)}</div>`
      ).join("<hr>"));
    });
    const selectedPir = chain[selectedPerson];
    const selectedLocation = selectedPir?.locations?.[selectedPlace] || selectedPir?.locations?.[0];
    if (selectedLocation) {
      const selectedNumber = selectedPir.number || 41;
      L.circleMarker([selectedLocation.lat, selectedLocation.lon], {
        radius: 22,
        color: "#ffe49a",
        weight: 2,
        fillColor: "#ffe49a",
        fillOpacity: 0.2,
        opacity: 0.95,
        interactive: false,
      }).addTo(markerLayer);
      const selectedMarker = L.circleMarker([selectedLocation.lat, selectedLocation.lon], {
        radius: 14,
        color: "#fff8dc",
        weight: 3,
        fillColor: "#bd3d2a",
        fillOpacity: 1,
        opacity: 1,
      }).addTo(markerLayer);
      selectedMarker.bindTooltip(`${selectedNumber}`, {
        permanent: true,
        direction: "center",
        className: "pir-number-tooltip is-selected",
        opacity: 1,
      });
      selectedMarker.bindPopup(`<strong>${selectedNumber}. ${escapeHtml(selectedPir.name)}</strong><br>${escapeHtml(selectedLocation.label)}<br><small>Рўйхатдан танланган пир</small>`);
    }
  };
  const bounds = [];
  routePoints.forEach(({ place }) => {
    bounds.push([place.lat, place.lon]);
  });
  const selectedPir = chain[selectedPerson];
  const selectedLocation = selectedPir?.locations?.[selectedPlace] || selectedPir?.locations?.[0];
  if (focusPirMapSelection && selectedLocation) {
    leafletMap.setView([selectedLocation.lat, selectedLocation.lon], 9);
    focusPirMapSelection = false;
  } else if (bounds.length > 1) leafletMap.fitBounds(bounds, { padding: [30, 30], maxZoom: 4 });
  else if (bounds.length === 1) leafletMap.setView(bounds[0], 7);
  renderNumberedMarkers();
  leafletMap.on("zoomend", renderNumberedMarkers);
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
  else if (route === "tariqat") app.innerHTML = `<iframe class="tariqat-frame" title="Бугунги тариқат вазифалари" src="tariqat-vazifalari.html?embed=1"></iframe>`;
  else if (route === "prayers") {
    app.innerHTML = renderPrayerShell();
    loadPrayerView();
  }
  else if (route === "memory") app.innerHTML = renderMemory();
  else if (route === "places") app.innerHTML = renderPlaces();
  else app.innerHTML = renderGuide();
  if (route === "places") requestAnimationFrame(addMap);
  if (telegramApp?.initData && !state.sync?.consented) {
    app.insertAdjacentHTML("afterbegin", state.sync.dismissed ? syncReminderMarkup() : syncConsentMarkup());
  }
  trackSectionView();
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
  const entered = Number.parseInt(String(value), 10);
  memory.quota = Math.max(1, Math.min(meta.max, Number.isFinite(entered) ? entered : 1));
  if (!memory.session || memory.session.status === "plan" || memory.session.status === "result") createMemorySession(memoryType);
  saveState();
  render(true);
}

app.addEventListener("click", (event) => {
  const button = event.target.closest("[data-action]");
  if (!button) return;
  const action = button.dataset.action;

  if (action === "enable-sync") {
    void enableProgressSync(button);
  } else if (action === "later-sync") {
    state.sync.dismissed = true;
    saveState();
    render(true);
  } else if (action === "nasihat-next" || action === "nasihat-prev") {
    event.preventDefault();
    event.stopPropagation();
    const keepNasihatOpen = app.querySelector(".nasihat-card")?.open || false;
    if (nasihatData.length > 1) {
      const direction = action === "nasihat-next" ? 1 : -1;
      activeNasihatIndex = (activeNasihatIndex + direction + nasihatData.length) % nasihatData.length;
    }
    render(true);
    if (keepNasihatOpen) app.querySelector(".nasihat-card")?.setAttribute("open", "");
  } else if (action === "prayer-view") {
    prayerView = button.dataset.view;
    render();
  } else if (action === "jump-to-lessons") {
    document.getElementById("daily-lessons")?.scrollIntoView({ behavior: "smooth", block: "start" });
  } else if (action === "count-one" || action === "count-ten" || action === "count-hundred" || action === "count-minus") {
    const index = Number(button.dataset.lesson);
    const lesson = lessons[index];
    if (!lesson) return;
    const amount = action === "count-one" ? 1 : action === "count-ten" ? 10 : action === "count-hundred" ? 100 : -1;
    const result = queueProgressChange(index, amount);
    if (result.count >= lesson.count && result.previous < lesson.count) {
      showToast(`${lesson.title}: бугунги саноқ бажарилди.`);
    }
    render(true);
    void flushPendingProgress().then(() => render(true));
  } else if (action === "count-reset") {
    const index = Number(button.dataset.lesson);
    if (!lessons[index]) return;
    queueProgressChange(index, 0, true);
    render(true);
    void flushPendingProgress().then(() => render(true));
  } else if (action === "memory-type") {
    memoryType = button.dataset.type;
    render();
  } else if (action === "memory-method") {
    const type = button.dataset.type;
    const method = button.dataset.method;
    if (!["pirs", "asma"].includes(type) || !["stages", "quota"].includes(method)) return;
    memoryType = type;
    memoryStore(type).method = method;
    createMemorySession(type);
    saveState();
    render();
  } else if (action === "asma-select") {
    const index = Number(button.dataset.index);
    if (!asmaData.names[index]) return;
    const session = getMemorySession("asma");
    session.items = [index];
    session.studyIndex = 0;
    session.status = "study";
    session.quiz = null;
    session.result = null;
    memoryType = "asma";
    saveState();
    render(true);
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
    focusPirMapSelection = true;
    render(true);
    requestAnimationFrame(() => document.getElementById("map")?.scrollIntoView({ behavior: "smooth", block: "center" }));
  } else if (action === "select-place") {
    selectedPlace = Number(button.dataset.place);
    focusPirMapSelection = true;
    render(true);
    requestAnimationFrame(() => document.getElementById("map")?.scrollIntoView({ behavior: "smooth", block: "center" }));
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
});

navButtons.forEach((button) => {
  button.addEventListener("click", () => {
    if (button.dataset.route === "today" && route !== "today" && nasihatData.length) {
      activeNasihatIndex = (activeNasihatIndex + 1 + Math.floor(Math.random() * (nasihatData.length - 1))) % nasihatData.length;
    }
    route = button.dataset.route;
    if (route === "guide") selectedLesson = null;
    render();
  });
});

app.addEventListener("error", (event) => {
  const image = event.target;
  if (image instanceof HTMLImageElement && image.classList.contains("nasihat-image")) {
    image.remove();
    app.querySelector(".nasihat-cover")?.classList.add("nasihat-no-image");
  }
}, true);

async function boot() {
  try {
    const [lessonResponse, pirsResponse, asmaResponse, nasihatResponse] = await Promise.all([
      fetch("lessons.json"),
      fetch("pirs.json"),
      fetch("asma_ul_husna.json"),
      fetch("nasihatlar.json"),
    ]);
    if (!lessonResponse.ok || !pirsResponse.ok || !asmaResponse.ok || !nasihatResponse.ok) throw new Error("Маълумот файллари очилмади.");
    lessons = await lessonResponse.json();
    pirData = await pirsResponse.json();
    asmaData = await asmaResponse.json();
    const nasihatPayload = await nasihatResponse.json();
    nasihatData = Array.isArray(nasihatPayload.items) ? nasihatPayload.items : [];
    if (nasihatData.length) activeNasihatIndex = Math.floor(Math.random() * nasihatData.length);
    state = loadState();
    syncDaily();
    if (telegramApp) {
      telegramApp.ready();
      telegramApp.expand();
      try { telegramApp.setHeaderColor("#102c29"); telegramApp.setBackgroundColor("#102c29"); } catch (_) {}
    }
    render();
    if (telegramApp?.initData && state.sync?.consented) {
      syncProgressOnOpen()
        .then(() => render(true))
        .catch((error) => {
          if (error.status === 403) revokeLocalSync();
          else showToast("Саноқлар ҳозирча қурилмада сақланди; интернетни текшириб қайта очинг.");
        });
    }
  } catch (error) {
    app.innerHTML = `<div class="empty-box"><strong>Илова очилмади</strong><p>${escapeHtml(error.message)} HTTPS манзилдан қайта очиб кўринг.</p></div>`;
  }
}

boot();
