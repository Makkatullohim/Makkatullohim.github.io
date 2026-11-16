const telegramApp = window.Telegram?.WebApp;
const apiBase = document.querySelector("meta[name='prayer-api-url']")?.content?.trim().replace(/\/$/, "");
const accessState = document.getElementById("access-state");
const dashboard = document.getElementById("dashboard");
const refreshButton = document.getElementById("refresh");

function showMessage(message) {
  accessState.replaceChildren();
  const text = document.createElement("p");
  text.textContent = message;
  accessState.append(text);
  accessState.hidden = false;
  dashboard.hidden = true;
}

function addSummaryCard(label, value) {
  const card = document.createElement("article");
  card.className = "summary-card";
  const title = document.createElement("span");
  title.textContent = label;
  const number = document.createElement("strong");
  number.textContent = Number(value || 0).toLocaleString("uz-UZ");
  card.append(title, number);
  return card;
}

function renderSummary(data) {
  const target = document.getElementById("summary-cards");
  target.replaceChildren(
    addSummaryCard("Рўйхатдан ўтганлар", data.total_users),
    addSummaryCard("Бугун фаол", data.active_today),
    addSummaryCard("7 кунда фаол", data.active_7d),
    addSummaryCard("Бугун бажарилган вирдлар", data.completed_today),
  );
}

function renderActivity(items) {
  const chart = document.getElementById("activity-chart");
  chart.replaceChildren();
  const maximum = Math.max(1, ...items.map((item) => Number(item.users || 0)));
  const weekday = new Intl.DateTimeFormat("uz-Cyrl-UZ", {
    timeZone: "Asia/Tashkent",
    weekday: "short",
  });
  for (const item of items) {
    const day = document.createElement("div");
    day.className = "activity-day";
    const value = document.createElement("span");
    value.className = "activity-value";
    value.textContent = Number(item.users || 0).toLocaleString("uz-UZ");
    const track = document.createElement("div");
    track.className = "activity-track";
    const bar = document.createElement("div");
    bar.className = "activity-bar";
    bar.style.height = `${Math.max(4, Number(item.users || 0) / maximum * 100)}%`;
    bar.setAttribute("aria-label", `${item.day}: ${item.users} фаол фойдаланувчи`);
    track.append(bar);
    const label = document.createElement("span");
    label.className = "activity-label";
    label.textContent = weekday.format(new Date(`${item.day}T12:00:00Z`));
    day.append(value, track, label);
    chart.append(day);
  }
}

function renderSectionViews(items) {
  const target = document.getElementById("section-views");
  target.replaceChildren();
  const maximum = Math.max(1, ...items.map((item) => Number(item.views || 0)));
  for (const item of items) {
    const row = document.createElement("div");
    row.className = "section-view-row";
    const name = document.createElement("span");
    name.className = "section-view-name";
    name.textContent = item.label;
    const track = document.createElement("div");
    track.className = "section-view-track";
    const bar = document.createElement("div");
    bar.className = "section-view-bar";
    bar.style.width = `${Math.max(0, Number(item.views || 0) / maximum * 100)}%`;
    track.append(bar);
    const count = document.createElement("span");
    count.className = "section-view-count";
    count.textContent = Number(item.views || 0).toLocaleString("uz-UZ");
    row.append(name, track, count);
    target.append(row);
  }
}

async function loadStats() {
  if (!telegramApp?.initData) {
    showMessage("Админ панелни Telegram’да ботдаги /admin буйруғи орқали очинг.");
    return;
  }
  if (!apiBase) {
    showMessage("Статистика сервери созланмаган.");
    return;
  }
  refreshButton.disabled = true;
  try {
    const response = await fetch(`${apiBase}/api/admin/stats`, {
      headers: { "X-Telegram-Init-Data": telegramApp.initData },
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "Админ панелига рухсат берилмади.");
    renderSummary(data);
    renderActivity(data.daily_active || []);
    renderSectionViews(data.section_views || []);
    document.getElementById("privacy-note").textContent = data.privacy_note || "Бўлимлар очилиши умумий ҳисобда кўрсатилади.";
    accessState.hidden = true;
    dashboard.hidden = false;
  } catch (error) {
    showMessage(error.message || "Статистикани юклаб бўлмади.");
  } finally {
    refreshButton.disabled = false;
  }
}

telegramApp?.ready();
telegramApp?.expand();
refreshButton.addEventListener("click", loadStats);
void loadStats();
