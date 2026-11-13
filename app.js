const app = document.getElementById("app");
const toast = document.getElementById("toast");
const navButtons = [...document.querySelectorAll(".nav-item")];
const telegramApp = window.Telegram?.WebApp;
const timezone = "Asia/Tashkent";
const storageKey = `dil-daftari-v1-${telegramApp?.initDataUnsafe?.user?.id || "local"}`;

let lessons = [];
let pirData;
let asmaData;
let state;
let route = "today";
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

function emptyState() {
  return {
    stage: 0,
    daily: null,
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
      return {
        ...base,
        ...saved,
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
      stage: state.stage,
      count: 0,
      done: state.stage >= lessons.length,
    };
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

function courseProgress() {
  const completed = state.completedStages.length;
  const percent = Math.round((completed / Math.max(1, lessons.length)) * 100);
  return `<div class="course-progress">
    <div class="progress-meta"><span>Дарслар йўли</span><span>${completed} / ${lessons.length}</span></div>
    <div class="progress-track"><span style="width:${percent}%"></span></div>
  </div>`;
}

function renderCounter(lesson, index, done) {
  const count = state.daily?.count || 0;
  const percent = Math.min(100, Math.round((count / lesson.count) * 100));
  return `<section class="counter-card">
    <div class="counter-head">
      <span class="section-label">Вирд саноғи</span>
      <span class="counter-figures"><b>${count.toLocaleString("uz-UZ")}</b> / ${lesson.count.toLocaleString("uz-UZ")}</span>
    </div>
    <div class="ring-wrap">
      <div class="count-ring" style="--progress:${percent}%">
        <button class="count-button" data-action="count-one" ${done ? "disabled" : ""} aria-label="Бир марта санаш">
          <strong>${count.toLocaleString("uz-UZ")}</strong>
          <small>${done ? "ЯКУНЛАНДИ" : "САНОҚ"}</small>
          <span class="tap-hint">${done ? "" : "+1 босинг"}</span>
        </button>
      </div>
    </div>
    ${done ? `<div class="complete-banner"><span>✦</span><span><strong>Бугунги вирд бажарилди.</strong> Кейинги босқич эртага очилади.</span></div>` : `
      <div class="counter-actions">
        <button class="counter-action subtle" data-action="count-minus">−1</button>
        <button class="counter-action" data-action="count-ten">+10</button>
        <button class="counter-action" data-action="count-hundred">+100</button>
        <button class="counter-action subtle" data-action="count-reset">↺</button>
      </div>`}
    ${courseProgress()}
  </section>`;
}

function renderToday() {
  syncDaily();
  document.getElementById("today-date").textContent = formatDate();
  if (lessons.length === 0) return `<div class="empty-box"><strong>Дарслар топилмади</strong><p>Қўлланма матнини қайта юкланг.</p></div>`;

  if (state.stage >= lessons.length && state.daily.stage >= lessons.length) {
    return `${pageIntro("КУНЛИК МАШҒУЛОТ", "Босқичлар якунланди", "Қўлланмани исталган вақтда қайта очиб ўқишингиз мумкин.")}
      <div class="empty-box"><strong>Тўққиз дарснинг барчаси якунланган</strong><p>Силсила ва исмларни ёдлаш бўлимларидан давом этинг.</p></div>
      ${courseProgress()}`;
  }

  const index = state.daily.done ? state.daily.stage : state.stage;
  const lesson = lessons[index];
  if (!lesson) return `${pageIntro("КУНЛИК МАШҒУЛОТ", "Дарс йўқ", "Қўлланмадан мавжуд дарсларни кўринг.")}`;
  const done = Boolean(state.daily.done);
  return `${pageIntro(`КУН ${index + 1} · ${lessons.length} БОСҚИЧ`, "Кунлик вирд", "Матнни ўқинг, маъноси устида тафаккур қилинг ва саноқни юритинг.")}
    <article class="paper-card today-card">
      <div class="lesson-topline"><span class="section-label">Бугунги дарс</span><span class="step-pill">${String(index + 1).padStart(2, "0")} / ${lessons.length}</span></div>
      <h2 class="lesson-title">${escapeHtml(lesson.title)}</h2>
      <div class="lesson-copy">${textWithBreaks(lesson.content)}</div>
      <div class="reflection-note"><span>✦</span><div>Оят ва изоҳларни шошилмай ўқинг. Маъносини англаб, сўнг вирд саноғини бошланг.</div></div>
    </article>
    ${renderCounter(lesson, index, done)}`;
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
  return `${pageIntro("СИЛСИЛА ХАРИТАСИ", "Одамлар ва жойлар", "Номни танланг — боғлиқ шаҳар ва ҳудудлар харитада очилади.")}
    <div class="chain-summary"><div><strong>Ҳолидия–Нақшбандия силсиласи</strong><br><span>40 ҳалқа ва кейинги давом алоҳида</span></div><span class="chain-count">40 + 1</span></div>
    <section class="map-card">
      <div class="map-top"><strong>${escapeHtml(selected?.name || "Жойни танланг")}</strong><span>${places.length} нуқта</span></div>
      <div id="map" role="application" aria-label="Силсила жойлари харитаси"></div>
      <div class="map-selected"><h3>${escapeHtml(selected?.name || "")}</h3><div class="location-pills">${places.map((place, index) => `<button class="location-pill" data-action="select-place" data-place="${index}">${escapeHtml(place.label)}</button>`).join("")}</div>
      <div class="button-row"><a class="secondary-button" href="https://www.openstreetmap.org/?mlat=${places[selectedPlace]?.lat || places[0]?.lat || 39}&mlon=${places[selectedPlace]?.lon || places[0]?.lon || 65}#map=5/${places[selectedPlace]?.lat || places[0]?.lat || 39}/${places[selectedPlace]?.lon || places[0]?.lon || 65}" target="_blank" rel="noopener">Харитани катта очиш ↗</a></div></div>
      <div class="map-note">${escapeHtml(pirData.source_note)}</div>
    </section>
    <div class="person-list">${renderPersonList()}</div>
    <div class="source-box"><strong>Манбалар</strong><br>${pirData.sources.map((source) => `<a href="${escapeHtml(source.url)}" target="_blank" rel="noopener">${escapeHtml(source.label)}</a>`).join(" · ")}<br><br>41-нуқта силсиладаги 40 ҳалқага қўшилмаган; алоҳида давом сифатида берилган.</div>`;
}

function addMap() {
  const mapNode = document.getElementById("map");
  if (!mapNode || !window.L) return;
  const selected = selectedPerson === 40 ? pirData.continuation : pirData.chain[selectedPerson];
  const places = selected?.locations || [];
  leafletMap = L.map(mapNode, { zoomControl: false, scrollWheelZoom: false }).setView([39, 63], 3);
  L.control.zoom({ position: "bottomright" }).addTo(leafletMap);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 18,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  }).addTo(leafletMap);
  const bounds = [];
  places.forEach((place, index) => {
    const marker = L.circleMarker([place.lat, place.lon], {
      radius: index === selectedPlace ? 9 : 7,
      color: "#102c29",
      weight: 2,
      fillColor: index === selectedPlace ? "#d3a862" : "#4f8067",
      fillOpacity: 0.95,
    }).addTo(leafletMap);
    marker.bindPopup(`<strong>${escapeHtml(selected.name)}</strong><br>${escapeHtml(place.label)}<br><small>Тахминий шаҳар/ҳудуд нуқтаси</small>`);
    bounds.push([place.lat, place.lon]);
    if (index === selectedPlace) marker.openPopup();
  });
  if (bounds.length > 1) leafletMap.fitBounds(bounds, { padding: [26, 26], maxZoom: 7 });
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
  const rows = lessons.map((lesson, index) => `<button class="guide-row" data-action="open-lesson" data-lesson="${index}"><span class="guide-num">${String(index + 1).padStart(2, "0")}</span><span><strong>${escapeHtml(lesson.title)}</strong><small>${lesson.count.toLocaleString("uz-UZ")} марта · ${state.completedStages.includes(index) ? "якунланган" : "қўлланма"}</small></span></button>`).join("");
  return `${pageIntro("ҚЎЛЛАНМА", "Дарслар кетма-кетлиги", "Исталган босқични очиб, матнини ўқинг.")}<div class="guide-list">${rows}</div>
    <div class="source-box">Вирд матни берилган қўлланма асосида киритилган. Қўшимча изоҳлар кейин босқичма-босқич қўшилади.</div>`;
}

function render(keepScroll = false) {
  const previousScroll = window.scrollY;
  if (leafletMap) {
    leafletMap.remove();
    leafletMap = null;
  }
  updateNav();
  if (route === "today") app.innerHTML = renderToday();
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

app.addEventListener("click", (event) => {
  const button = event.target.closest("[data-action]");
  if (!button) return;
  const action = button.dataset.action;

  if (action === "count-one" || action === "count-ten" || action === "count-hundred" || action === "count-minus") {
    if (state.daily.done) return;
    const amount = action === "count-one" ? 1 : action === "count-ten" ? 10 : action === "count-hundred" ? 100 : -1;
    const lesson = lessons[state.stage];
    state.daily.count = Math.max(0, Math.min(lesson.count, state.daily.count + amount));
    if (state.daily.count >= lesson.count) {
      state.daily.done = true;
      if (!state.completedStages.includes(state.stage)) state.completedStages.push(state.stage);
      state.stage += 1;
      showToast("Бугунги вирд бажарилди.");
    }
    saveState();
    render(true);
  } else if (action === "count-reset") {
    if (state.daily.done) return;
    state.daily.count = 0;
    saveState();
    render(true);
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
