// Court Sense — UI, state and wiring.
import * as store from "./store.js";
import {
  TIERS, tierOf, relLabel, relClass,
  applyResult, bestPairing, pickFoursome, makePlayer, parseRoster, samplePlayers,
} from "./engine.js";

const THEME_KEY = "courtsense_theme";
const QUEUE_WINDOW = 8; // how far down the queue the auto-matcher looks for a level match
const DEFAULTS = {
  courts: 2, levelDisplay: "text", arrSeq: 0, matchCount: 0,
  pairHist: {}, oppHist: {}, lastResults: null, sessionDate: null,
  queue: [], active: [],
  playersSort: { key: "name", dir: 1 }, playerFilter: "all",
};
let S = { players: [] };
let uiImportOpen = false;

/* ---------- dates ---------- */
function todayISO() {
  const d = new Date();
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}
function fromISO(iso) { return new Date((iso || todayISO()) + "T12:00:00"); }
function weekdayName(iso) { return fromISO(iso).toLocaleDateString(undefined, { weekday: "long" }); }
function dateShort(iso) { return fromISO(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" }); }

/* ---------- state persistence ---------- */
async function load() {
  let data;
  try { data = await store.loadAll(); } catch (e) { data = { players: [], kv: null }; }
  S = { players: data.players || [], ...DEFAULTS, ...(data.kv || {}) };
  S.pairHist = S.pairHist || {}; S.oppHist = S.oppHist || {};
  S.playersSort = S.playersSort || { key: "name", dir: 1 };
  if (!S.sessionDate) S.sessionDate = todayISO();
  if (!Array.isArray(S.queue)) S.queue = [];
  if (!Array.isArray(S.active)) S.active = [];
  // self-heal: every player marked present must be in the queue or on a court
  const placed = new Set([...S.queue, ...S.active.flatMap(c => [...c.teamA, ...c.teamB])]);
  S.queue = S.queue.filter(id => byId(id) && byId(id).present);
  S.players.filter(p => p.present && !placed.has(p.id))
    .sort((a, b) => ((a.gamesTonight || 0) - (b.gamesTonight || 0)) || ((a.arr || 0) - (b.arr || 0)))
    .forEach(p => S.queue.push(p.id));
  if (S.lastResults && S.lastResults.court === undefined) S.lastResults = null;
  delete S.current; delete S.round;
}
function kvSnapshot() { const { players, ...kv } = S; return kv; }
function save() {
  try { store.saveKV(kvSnapshot()); store.putPlayers(S.players); } catch (e) {}
}

/* ---------- helpers ---------- */
const byId = id => S.players.find(p => p.id === id);
const present = () => S.players.filter(p => p.present);
function nextArr() { S.arrSeq = (S.arrSeq || 0) + 1; return S.arrSeq; }
function esc(s) { return String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
function freeCourtNums() {
  const used = new Set(S.active.map(c => c.num));
  const out = [];
  for (let n = 1; n <= S.courts; n++) if (!used.has(n)) out.push(n);
  return out;
}
function tierChip(r) {
  const t = tierOf(r);
  const txt = S.levelDisplay === "class" ? t.cls : t.name;
  return `<span class="tchip" data-tier="${t.key}" title="${t.name} · Class ${t.cls}">${txt}</span>`;
}
function tierLegendHtml() {
  return TIERS.map((t, i) => {
    const hi = TIERS[i + 1] ? TIERS[i + 1].min : null;
    const range = i === 0 ? `under ${TIERS[1].min.toFixed(1)}`
      : (hi ? `${t.min.toFixed(1)}–${hi.toFixed(1)}` : `${t.min.toFixed(1)}+`);
    return `<div class="legendrow"><span class="tchip" data-tier="${t.key}">${t.name}</span>` +
      `<span class="legcls">Class ${t.cls}</span><span class="legrange mono faint">${range}</span></div>`;
  }).join("");
}

const V = {
  tonight: document.getElementById("view-tonight"),
  players: document.getElementById("view-players"),
  how: document.getElementById("view-how"),
};
function render() { renderTonight(); renderPlayers(); }

/* ---------- state operations ---------- */
function addToList(p) { if (!p.present) { p.present = true; p.arr = nextArr(); S.queue.push(p.id); } }
function removeTonight(id) { const p = byId(id); if (p) p.present = false; S.queue = S.queue.filter(x => x !== id); save(); }
function moveQueue(id, dir) {
  const i = S.queue.indexOf(id), j = i + dir;
  if (i < 0 || j < 0 || j >= S.queue.length) return;
  [S.queue[i], S.queue[j]] = [S.queue[j], S.queue[i]];
  save(); refreshLists();
}
function startOne(num) {
  const ids = pickFoursome(S.queue, byId, QUEUE_WINDOW);
  if (!ids) return false;
  const pairing = bestPairing(ids.map(byId), num, S.pairHist, S.oppHist);
  S.active.push({ id: "m" + (++S.matchCount), num, teamA: pairing.teamA, teamB: pairing.teamB, scoreA: 0, scoreB: 0 });
  S.queue = S.queue.filter(id => !ids.includes(id));
  return true;
}
function startMatch(num) {
  if (startOne(num)) { S.lastResults = null; save(); renderTonight(); }
}
function fillAllCourts() {
  let started = false;
  for (const num of freeCourtNums()) {
    if (S.queue.length < 4) break;
    if (startOne(num)) started = true;
  }
  if (started) { S.lastResults = null; save(); renderTonight(); }
}
function finishMatch(cid) {
  const court = S.active.find(c => c.id === cid);
  if (!court) return;
  if (!((court.scoreA === 6) !== (court.scoreB === 6))) {
    flashBtn(`[data-finish="${cid}"]`, "Race to 6 — one team must reach 6");
    return;
  }
  const changes = applyResult(court, S.players, S.matchCount, S.pairHist, S.oppHist);
  S.active = S.active.filter(c => c.id !== cid);
  S.queue.push(...court.teamA, ...court.teamB);
  S.lastResults = { court: court.num, changes };
  save(); renderTonight(); renderPlayers();
}
function newSession() {
  S.players.forEach(p => { p.present = false; p.gamesTonight = 0; p.lastRound = -99; });
  S.queue = []; S.active = []; S.lastResults = null; S.matchCount = 0; S.arrSeq = 0;
  S.sessionDate = todayISO();
  save(); renderTonight();
}

/* ---------- Tonight ---------- */
function renderTonight() {
  const el = V.tonight;
  if (S.players.length === 0) {
    el.innerHTML = onboarding("tonight");
    wireOnboarding(el);
    return;
  }

  let html = resultsBanner();
  html += `<div class="row spread wrap" style="align-items:flex-end;gap:10px">
    <div><div class="eyebrow">Open-play session</div>
      <h2 style="font-size:22px">${weekdayName(S.sessionDate)} open play</h2></div>
    <label class="field" style="flex-direction:row;align-items:center;gap:7px;font-size:12px">
      <span>Day</span><input type="date" id="sessionDate" value="${S.sessionDate}" style="padding:6px 9px;font-size:13px"></label>
  </div>`;

  // Add players
  html += `<div class="card pad stack">
    <div class="eyebrow">Add players to the queue</div>
    <input type="search" id="searchBox" placeholder="Search ${S.players.length} members by name…" autocomplete="off" spellcheck="false">
    <div id="searchResults" class="stack" style="gap:6px"></div>
  </div>`;

  // Courts in play (active + free)
  const free = freeCourtNums();
  const cards = [...S.active].sort((a, b) => a.num - b.num).map(activeCourtCard).join("")
    + free.map(freeCourtCard).join("");
  const startAll = (free.length >= 2 && S.queue.length >= 4)
    ? `<button class="btn cta sm" id="startAll">Start all open courts →</button>` : "";
  html += `<div class="stack" style="gap:10px">
    <div class="row spread wrap" style="align-items:center;gap:8px">
      <div class="eyebrow">On court now · ${S.active.length}/${S.courts} court${S.courts > 1 ? "s" : ""} in play</div>
      ${startAll}
    </div>
    <div class="courts">${cards}</div>
  </div>`;

  // Queue
  html += `<div class="card pad stack">
    <div class="row spread wrap">
      <div class="eyebrow">Up next · <span id="queueCount">${S.queue.length}</span> waiting</div>
      <button class="btn ghost sm" id="newSession">New session</button>
    </div>
    <p class="tiny muted" style="margin:0">Top of the queue plays next. Use ▲▼ to change the order, or × to take someone off.</p>
    <ol class="queue" id="queueList"></ol>
  </div>`;

  // Everyone here today
  html += `<div class="card pad stack">
    <div class="row spread wrap">
      <div class="eyebrow">Tonight's players · <span id="todayCount">${present().length}</span></div>
      <div class="tiny muted" id="todayMeta"></div>
    </div>
    <div class="tablewrap"><table class="today">
      <thead><tr><th>Player</th><th class="r">Level</th><th class="r">Games</th><th>Status</th></tr></thead>
      <tbody id="todayBody"></tbody>
    </table></div>
  </div>`;

  el.innerHTML = html;
  wireTonight();
}

function activeCourtCard(court) {
  const A = court.teamA.map(byId), B = court.teamB.map(byId);
  const avg = (A[0].rating + A[1].rating + B[0].rating + B[1].rating) / 4;
  const plRow = p => `<div class="pl"><span class="nm">${esc(p.name)}</span><span class="lv">${p.rating.toFixed(2)}</span></div>`;
  return `<div class="court" data-court-id="${court.id}">
    <div class="court-hd"><span class="cn">Court ${court.num}</span><span class="cavg">~${avg.toFixed(1)} level</span></div>
    <div class="team"><div class="teamtag">Team 1</div>${A.map(plRow).join("")}</div>
    <div class="vs">VS</div>
    <div class="team b"><div class="teamtag">Team 2</div>${B.map(plRow).join("")}</div>
    <div class="score">
      <div class="scol"><span class="slbl">Team 1</span>${stepper(court.id, "A", court.scoreA)}</div>
      <span class="dash">–</span>
      <div class="scol"><span class="slbl">Team 2</span>${stepper(court.id, "B", court.scoreB)}</div>
    </div>
    <div class="score-cap">Games won · race to 6 (sudden death at 5–5)</div>
    <div class="court-foot"><button class="btn cta finishbtn" data-finish="${court.id}">Match finished ✓</button></div>
  </div>`;
}
function freeCourtCard(num) {
  return `<div class="court free">
    <div class="court-hd"><span class="cn">Court ${num}</span><span class="cavg">open</span></div>
    <div class="freebody">
      <p class="muted" style="margin:0;font-weight:600">Court free</p>
      <button class="btn cta startbtn" data-start="${num}">Start next match →</button>
      <p class="startneed tiny faint" style="margin:0"></p>
    </div>
  </div>`;
}
function stepper(court, team, val) {
  return `<div class="stepper" data-stepper="${court}~${team}">
    <button data-step="dec" aria-label="minus">–</button>
    <span class="val num">${val}</span>
    <button data-step="inc" aria-label="plus">+</button></div>`;
}
function resultsBanner() {
  if (!S.lastResults) return "";
  const r = S.lastResults;
  return `<div class="banner">
    <span aria-hidden="true" style="font-size:18px">✓</span>
    <div class="grow"><span class="em">Court ${r.court} finished.</span>
    <span class="tiny muted"> ${r.changes.length} ratings updated — those players are back in the queue.</span></div>
    <button class="btn ghost sm" id="dismissBanner">Dismiss</button>
  </div>`;
}
function renderQueue() {
  const waiting = S.queue.length;
  const cnt = document.getElementById("queueCount"); if (cnt) cnt.textContent = waiting;
  document.querySelectorAll(".startbtn").forEach(b => { b.disabled = waiting < 4; });
  document.querySelectorAll(".startneed").forEach(e => { e.textContent = waiting >= 4 ? "" : `needs 4 waiting (${waiting} in queue)`; });
  const list = document.getElementById("queueList"); if (!list) return;
  if (!waiting) { list.innerHTML = `<li class="tiny faint" style="list-style:none">Queue empty — add players above.</li>`; return; }
  list.innerHTML = S.queue.map((id, i) => {
    const p = byId(id);
    return `<li class="qrow">
      <span class="qpos num">${i + 1}</span>
      <span class="qname">${esc(p.name)}</span>
      <span class="qlv num">${p.rating.toFixed(2)}</span>
      <span class="qgames num faint">${p.gamesTonight || 0}g</span>
      <span class="qmove">
        <button data-up="${id}" aria-label="Move up" ${i === 0 ? "disabled" : ""}>▲</button>
        <button data-down="${id}" aria-label="Move down" ${i === waiting - 1 ? "disabled" : ""}>▼</button>
        <button class="qx" data-rm="${id}" aria-label="Remove">×</button>
      </span></li>`;
  }).join("");
}
function statusOf(id) {
  const c = S.active.find(c => c.teamA.includes(id) || c.teamB.includes(id));
  if (c) return { label: `Court ${c.num}`, kind: "playing" };
  const qi = S.queue.indexOf(id);
  if (qi >= 0) return { label: `Waiting #${qi + 1}`, kind: "waiting" };
  return { label: "—", kind: "idle" };
}
function renderToday() {
  const pres = present();
  const cnt = document.getElementById("todayCount"); if (cnt) cnt.textContent = pres.length;
  const meta = document.getElementById("todayMeta");
  if (meta) meta.textContent = `${S.active.length * 4} on court · ${S.queue.length} waiting`;
  const body = document.getElementById("todayBody"); if (!body) return;
  if (!pres.length) { body.innerHTML = `<tr><td colspan="4" class="faint tiny">No one added yet.</td></tr>`; return; }
  body.innerHTML = [...pres].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0).map(p => {
    const s = statusOf(p.id);
    return `<tr><td><b>${esc(p.name)}</b></td>` +
      `<td class="r"><span class="level">${p.rating.toFixed(2)}</span></td>` +
      `<td class="r num">${p.gamesTonight || 0}</td>` +
      `<td><span class="stat ${s.kind}">${s.label}</span></td></tr>`;
  }).join("");
}
function refreshLists() { renderQueue(); renderToday(); }

/* ---------- search / add ---------- */
function updateSearch() {
  const box = document.getElementById("searchBox"), results = document.getElementById("searchResults");
  if (!box || !results) return;
  const raw = box.value.trim(), ql = raw.toLowerCase();
  if (!ql) { results.innerHTML = `<p class="tiny faint" style="margin:2px 0">Type a name to add someone. Not on the roster? Type their full name and tap “Add new”.</p>`; return; }
  const matches = S.players.filter(p => !p.present && p.name.toLowerCase().includes(ql)).slice(0, 25);
  let html = matches.map(p =>
    `<div class="sres"><span class="nm">${esc(p.name)}</span>${tierChip(p.rating)}<span class="lv">${p.rating.toFixed(2)}</span>` +
    `<button class="btn sm primary addbtn" data-add="${p.id}" aria-label="Add ${esc(p.name)}">+</button></div>`).join("");
  const exact = S.players.some(p => p.name.toLowerCase() === ql);
  if (!matches.length && exact) html += `<p class="tiny faint" style="margin:2px 0">“${esc(raw)}” is already playing tonight.</p>`;
  if (!exact) html += `<button class="btn sm newp" data-newname="${esc(raw)}">+ Add “${esc(raw)}” as a new player</button>`;
  results.innerHTML = html;
}
function addNewPerson(name) {
  name = (name || "").trim(); if (!name) return;
  const p = makePlayer(name, 3.5);
  S.players.push(p); addToList(p); save();
  const box = document.getElementById("searchBox"); if (box) box.value = "";
  refreshLists(); updateSearch(); renderPlayers();
}

/* ---------- Players ---------- */
function renderPlayers() {
  const el = V.players;
  if (S.players.length === 0) {
    el.innerHTML = onboarding("players") + importPanelHtml();
    wireOnboarding(el); wireImport(el);
    return;
  }
  const f = S.playerFilter;
  let list = [...S.players];
  if (f === "present") list = list.filter(p => p.present);
  if (f === "prov") list = list.filter(p => p.reliability < 0.4);
  const { key, dir } = S.playersSort;
  list.sort((a, b) => {
    if (key === "name") return a.name < b.name ? -dir : a.name > b.name ? dir : 0;
    let va, vb;
    if (key === "record") { va = a.wins - a.losses; vb = b.wins - b.losses; }
    else if (key === "games") { va = a.games; vb = b.games; }
    else { va = a.rating; vb = b.rating; }
    return (va - vb) * dir;
  });
  const th = (k, label, r) => `<th class="${r ? "r " : ""}${key === k ? "sorted" : ""}" data-sort="${k}">${label}${key === k ? (dir < 0 ? " ↓" : " ↑") : ""}</th>`;

  el.innerHTML = `
    <div><div class="eyebrow">Club roster</div><h2 style="font-size:22px">Players & ratings</h2></div>
    <div class="row spread wrap" style="gap:10px">
      <div class="seg" role="group" aria-label="filter">
        <button data-filter="all" aria-pressed="${f === "all"}">All ${S.players.length}</button>
        <button data-filter="present" aria-pressed="${f === "present"}">Here tonight</button>
        <button data-filter="prov" aria-pressed="${f === "prov"}">Provisional</button>
      </div>
      <div class="row" style="gap:8px;align-items:center">
        <span class="tiny muted" style="font-weight:700">Show as</span>
        <div class="seg" role="group" aria-label="level display">
          <button data-disp="text" aria-pressed="${S.levelDisplay === 'text'}">Text</button>
          <button data-disp="class" aria-pressed="${S.levelDisplay === 'class'}">Class</button>
        </div>
      </div>
    </div>
    ${importPanelHtml()}
    <div id="relHelp" class="callout" hidden>
      <div class="grow"><b>Reliability</b> is how settled a player's level is, based on how many games they've played. New players start low and their level moves quickly; with a long match history it climbs toward 100% and the level barely changes.</div>
      <button class="x" id="relHelpClose" aria-label="Close">×</button>
    </div>
    <div class="card"><div class="tablewrap"><table>
      <thead><tr>
        ${th("name", "Player")}<th>Tier</th>${th("rating", "Level", true)}
        <th class="r">Reliability <button class="infobtn" id="relInfo" aria-label="About reliability" aria-expanded="false">i</button></th>
        ${th("record", "W–L", true)}${th("games", "Games", true)}
        <th class="r">Last move</th>
      </tr></thead>
      <tbody>${list.map(playerRow).join("")}</tbody>
    </table></div></div>
    <div class="row wrap" style="gap:8px">
      <button class="btn sm" id="openImport">Import members</button>
      <button class="btn sm ghost" id="addPlayer">+ Add one player</button>
      <button class="btn sm ghost" id="clearAll" style="margin-left:auto;color:var(--bad)">Clear all data</button>
    </div>
    <form class="card pad row wrap" id="addForm" hidden style="gap:10px;align-items:flex-end">
      <label class="field grow">Name<input type="text" id="np_name" placeholder="e.g. Alex M." autocomplete="off"></label>
      <label class="field">Starting level<input type="number" id="np_lvl" value="3.50" step="0.05" min="1.5" max="6" style="width:112px"></label>
      <button class="btn primary" type="submit">Add player</button>
      <button class="btn ghost" type="button" id="np_cancel">Cancel</button>
    </form>`;
  wirePlayers(); wireImport(el);
}
function playerRow(p) {
  const mv = p.delta > 0 ? `<span class="trend up">▲ ${p.delta.toFixed(3)}</span>`
    : p.delta < 0 ? `<span class="trend down">▼ ${Math.abs(p.delta).toFixed(3)}</span>`
    : `<span class="trend faint">–</span>`;
  return `<tr>
    <td><b>${esc(p.name)}</b>${p.present ? ` <span class="tiny" style="color:var(--court)">• here</span>` : ""}</td>
    <td>${tierChip(p.rating)}</td>
    <td class="r"><span class="level">${p.rating.toFixed(2)}</span></td>
    <td class="r num">${Math.round(p.reliability * 100)}%</td>
    <td class="r num">${p.wins}–${p.losses}</td>
    <td class="r num">${p.games}</td>
    <td class="r">${mv}</td>
  </tr>`;
}

/* ---------- onboarding + import ---------- */
function onboarding(where) {
  return `<div class="empty">
    <span class="big" aria-hidden="true"></span>
    <h2>Welcome to Court Sense</h2>
    <p>Add your club's members to begin. Paste or import a list, or try it with a sample club first.</p>
    <div class="row wrap" style="gap:10px;justify-content:center">
      <button class="btn cta" data-onb="import">Import members</button>
      <button class="btn" data-onb="sample">Add 28 sample players</button>
    </div>
    ${where === "tonight" ? `<p class="tiny faint">You can manage members any time on the Players tab.</p>` : ``}
  </div>`;
}
function wireOnboarding(el) {
  el.querySelectorAll("[data-onb]").forEach(b => b.addEventListener("click", () => {
    if (b.dataset.onb === "sample") { S.players = samplePlayers(); save(); render(); }
    else { uiImportOpen = true; setView("players"); }
  }));
}
function importPanelHtml() {
  return `<div class="card pad stack" id="importPanel" ${uiImportOpen ? "" : "hidden"}>
    <div class="row spread"><div class="eyebrow">Import members</div>
      <button class="btn ghost sm" id="importClose">Close</button></div>
    <p class="tiny muted" style="margin:0">Paste a list — one member per line. Add a level after a comma if you have it (e.g. <span class="mono">Maria Chen, 3.5</span>); otherwise everyone starts at 3.50 and the ratings sort themselves out.</p>
    <textarea id="importText" placeholder="Maria Chen, 3.5&#10;James Reyes, 4.0&#10;Priya Singh&#10;Tom Flores, 2.5"></textarea>
    <div class="row spread wrap">
      <span class="tiny muted" id="importCount">0 members found</span>
      <div class="row" style="gap:8px">
        <button class="btn sm ghost" id="importCancel">Cancel</button>
        <button class="btn sm primary" id="importDo">Import</button>
      </div>
    </div>
  </div>`;
}
function wireImport(el) {
  const panel = el.querySelector("#importPanel");
  if (!panel) return;
  const text = panel.querySelector("#importText");
  const count = panel.querySelector("#importCount");
  const existing = new Set(S.players.map(p => p.name.toLowerCase()));
  const refresh = () => {
    const rows = parseRoster(text.value);
    const fresh = rows.filter(r => !existing.has(r.name.toLowerCase()));
    count.textContent = `${rows.length} found · ${fresh.length} new to add`;
    return fresh;
  };
  text.addEventListener("input", refresh);
  const close = () => { uiImportOpen = false; renderPlayers(); };
  panel.querySelector("#importClose").addEventListener("click", close);
  panel.querySelector("#importCancel").addEventListener("click", close);
  panel.querySelector("#importDo").addEventListener("click", () => {
    const fresh = refresh();
    if (!fresh.length) { close(); return; }
    fresh.forEach(r => S.players.push(makePlayer(r.name, r.rating)));
    uiImportOpen = false; save(); render();
  });
  const openBtn = el.querySelector("#openImport");
  if (openBtn) openBtn.addEventListener("click", () => { uiImportOpen = true; renderPlayers(); panel.scrollIntoView?.({ behavior: "smooth", block: "nearest" }); });
  if (uiImportOpen) text.focus();
}

/* ---------- How it works ---------- */
function renderHow() {
  V.how.innerHTML = `
  <div class="card pad explain stack">
    <div><div class="eyebrow">The idea</div><h2 style="font-size:22px">A rating that figures out your real level</h2></div>
    <p>Every player carries a <b>level</b> (like <span class="k">3.80</span>) and a <b>reliability</b> score for that level.
    After each match the app nudges levels using three things: the final score, your partner's level, and your opponents' levels — the same logic behind a DUPR rating in pickleball.</p>
    <div class="steps">
      <div class="step"><span class="n">1</span><div><b>Teams are judged on their average.</b> A court's two players combine into one team level, and the result is measured against what the two team levels predicted.</div></div>
      <div class="step"><span class="n">2</span><div><b>Carrying shows up; being carried shows up.</b> Win with a lower-level partner against tough opponents and you beat expectations — your level rises. Keep winning no matter who you're paired with and the app concludes you're underrated, and bumps you up.</div></div>
      <div class="step"><span class="n">3</span><div><b>Reliability controls the speed.</b> New players move fast while the app is still learning them (<span class="k">Provisional</span>). Once someone has a long history the level barely wobbles (<span class="k">Reliable</span>) — the reliability number on the Players tab shows how much to trust each rating.</div></div>
    </div>
  </div>

  <div class="card pad explain stack">
    <div><div class="eyebrow">Levels & classes</div><h3>From a number to a class</h3></div>
    <p>The engine works in precise numbers (like <span class="k">3.80</span>) so a level drifts up or down game by game as players win or lose. Those numbers group into five bands you can show as words or as class letters:</p>
    <div class="tierlegend">${tierLegendHtml()}</div>
    <p class="tiny muted">Switch <b>Text</b> / <b>Class</b> on the Players tab. The roster lists alphabetically by default — tap <b>Level</b> to sort by rating instead.</p>
  </div>

  <div class="card pad explain stack">
    <div><div class="eyebrow">Queue & courts</div><h3>How matches run</h3></div>
    <p>Each open-play session is named by its day. Players share one waiting queue, and courts fill from it:</p>
    <div class="steps">
      <div class="step"><span class="n">1</span><div><b>Everyone joins one queue, first come first served.</b> Add players as they arrive. Reorder the line by hand any time with the ▲▼ buttons, or take someone off with ×.</div></div>
      <div class="step"><span class="n">2</span><div><b>Courts fill from the front.</b> Tap <b>Start next match</b> on a free court and the app seats the player who's waited longest, plus the three nearest to them in level, then balances the two teams.</div></div>
      <div class="step"><span class="n">3</span><div><b>Each court finishes on its own.</b> Every court has its own <b>Finish match</b> button — enter the race-to-6 score, those four drop to the back of the queue, and the court opens for the next group. Courts never have to finish together.</div></div>
    </div>
  </div>

  <div class="card pad explain stack">
    <div><div class="eyebrow">Members & offline</div><h3>Works at the court with no signal</h3></div>
    <p>Members live on this device, so <b>import your roster once</b> (paste a list or CSV on the Players tab) and it's there every session. The whole app <b>works offline</b> — install it to your home screen and it runs at the court with no signal, saving everything on the device. Syncing results to a central database and player logins are later phases.</p>
  </div>`;
}

/* ---------- wiring: Tonight ---------- */
function wireTonight() {
  const el = V.tonight;
  const q = sel => el.querySelector(sel);

  q("#sessionDate") && q("#sessionDate").addEventListener("change", e => {
    S.sessionDate = e.target.value || todayISO(); save(); renderTonight();
  });
  q("#newSession") && q("#newSession").addEventListener("click", () => {
    if (!confirm("Start a new session? This clears tonight's courts and queue. Members and ratings stay.")) return;
    newSession();
  });
  q("#dismissBanner") && q("#dismissBanner").addEventListener("click", () => { S.lastResults = null; save(); renderTonight(); });

  el.querySelectorAll("[data-stepper]").forEach(st => {
    const [cid, team] = st.dataset.stepper.split("~");
    const court = S.active.find(c => c.id === cid);
    if (!court) return;
    st.querySelectorAll("[data-step]").forEach(btn => btn.addEventListener("click", () => {
      const k = team === "A" ? "scoreA" : "scoreB";
      court[k] = Math.max(0, Math.min(6, court[k] + (btn.dataset.step === "inc" ? 1 : -1)));
      st.querySelector(".val").textContent = court[k]; save();
    }));
  });
  el.querySelectorAll("[data-finish]").forEach(b => b.addEventListener("click", () => finishMatch(b.dataset.finish)));
  el.querySelectorAll("[data-start]").forEach(b => b.addEventListener("click", () => startMatch(parseInt(b.dataset.start, 10))));
  q("#startAll") && q("#startAll").addEventListener("click", fillAllCourts);

  const sb = q("#searchBox");
  if (sb) {
    sb.addEventListener("input", updateSearch);
    q("#searchResults").addEventListener("click", e => {
      const add = e.target.closest("[data-add]");
      if (add) { addToList(byId(add.dataset.add)); save(); refreshLists(); updateSearch(); return; }
      const np = e.target.closest("[data-newname]");
      if (np) addNewPerson(np.dataset.newname);
    });
  }
  const ql = q("#queueList");
  if (ql) ql.addEventListener("click", e => {
    const up = e.target.closest("[data-up]"); if (up) { moveQueue(up.dataset.up, -1); return; }
    const dn = e.target.closest("[data-down]"); if (dn) { moveQueue(dn.dataset.down, 1); return; }
    const rm = e.target.closest("[data-rm]"); if (rm) { removeTonight(rm.dataset.rm); refreshLists(); updateSearch(); }
  });
  refreshLists(); updateSearch();
}
let flashT = null;
function flashBtn(sel, msg) {
  const b = V.tonight.querySelector(sel);
  if (!b) return;
  const old = b.textContent;
  b.textContent = msg; b.style.background = "var(--bad)"; b.style.borderColor = "var(--bad)"; b.style.color = "#fff";
  clearTimeout(flashT);
  flashT = setTimeout(() => { b.textContent = old; b.style.background = ""; b.style.borderColor = ""; b.style.color = ""; }, 2400);
}

/* ---------- wiring: Players ---------- */
function wirePlayers() {
  const el = V.players;
  el.querySelectorAll("th[data-sort]").forEach(th => th.addEventListener("click", () => {
    const k = th.dataset.sort;
    if (S.playersSort.key === k) S.playersSort.dir *= -1;
    else S.playersSort = { key: k, dir: k === "name" ? 1 : -1 };
    save(); renderPlayers();
  }));
  el.querySelectorAll("[data-filter]").forEach(b => b.addEventListener("click", () => { S.playerFilter = b.dataset.filter; save(); renderPlayers(); }));
  el.querySelectorAll("[data-disp]").forEach(b => b.addEventListener("click", () => { S.levelDisplay = b.dataset.disp; save(); renderPlayers(); renderTonight(); }));

  const info = el.querySelector("#relInfo"), help = el.querySelector("#relHelp");
  if (info && help) {
    info.addEventListener("click", e => { e.stopPropagation(); const show = help.hidden; help.hidden = !show; info.setAttribute("aria-expanded", String(show)); });
    el.querySelector("#relHelpClose").addEventListener("click", () => { help.hidden = true; info.setAttribute("aria-expanded", "false"); });
  }
  const addBtn = el.querySelector("#addPlayer"), form = el.querySelector("#addForm");
  addBtn.addEventListener("click", () => { form.hidden = !form.hidden; if (!form.hidden) el.querySelector("#np_name").focus(); });
  el.querySelector("#np_cancel").addEventListener("click", () => { form.hidden = true; });
  form.addEventListener("submit", e => {
    e.preventDefault();
    const name = el.querySelector("#np_name").value.trim();
    if (!name) return;
    const r = parseFloat(el.querySelector("#np_lvl").value) || 3.5;
    S.players.push(makePlayer(name, r));
    save(); renderPlayers(); renderTonight();
  });
  el.querySelector("#clearAll").addEventListener("click", async () => {
    if (!confirm("Clear ALL members, ratings and tonight's data from this device? This can't be undone.")) return;
    try { await store.clearAll(); } catch (e) {}
    S = { players: [], ...DEFAULTS, pairHist: {}, oppHist: {}, queue: [], active: [], sessionDate: todayISO() };
    render();
  });
}

/* ---------- tabs + theme + courts ---------- */
function setView(v) {
  for (const k in V) V[k].hidden = (k !== v);
  document.querySelectorAll(".tab").forEach(t => t.setAttribute("aria-selected", t.dataset.view === v));
  if (v === "how") renderHow();
  if (v === "players") renderPlayers();
  try { location.hash = v; } catch (e) {}
  window.scrollTo({ top: 0, behavior: "instant" });
}
function wireStatic() {
  document.querySelectorAll(".tab").forEach(t => t.addEventListener("click", () => setView(t.dataset.view)));
  const themeBtn = document.getElementById("themeBtn");
  themeBtn.addEventListener("click", () => {
    const now = document.documentElement.getAttribute("data-theme");
    const sysDark = matchMedia("(prefers-color-scheme:dark)").matches;
    const next = now ? (now === "dark" ? "light" : "dark") : (sysDark ? "light" : "dark");
    document.documentElement.setAttribute("data-theme", next);
    try { localStorage.setItem(THEME_KEY, next); } catch (e) {}
  });
  try { const t = localStorage.getItem(THEME_KEY); if (t) document.documentElement.setAttribute("data-theme", t); } catch (e) {}
  const courtTop = document.getElementById("courtTop");
  courtTop.value = S.courts;
  courtTop.addEventListener("change", () => { S.courts = Math.max(1, parseInt(courtTop.value, 10)) || 2; save(); renderTonight(); });
}

/* ---------- boot ---------- */
(async function boot() {
  await load();
  wireStatic();
  render();
  const start = (location.hash || "").replace("#", "");
  setView(["tonight", "players", "how"].includes(start) ? start : "tonight");
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
  }
})();
