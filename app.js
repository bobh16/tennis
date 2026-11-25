// Court Sense — UI, state and wiring.
import * as store from "./store.js";
import {
  TIERS, tierOf, relLabel, relClass,
  applyResult, bestPairing, pickFoursome, makePlayer, parseRoster, samplePlayers,
} from "./engine.js";
import { createTournaments } from "./tournaments.js";
import { syncNow as supaSync, configured as supaConfigured } from "./sync.js";

const THEME_KEY = "courtsense_theme";
const QUEUE_WINDOW = 8; // how far down the queue the auto-matcher looks for a level match
const DEFAULTS = {
  courts: 2, levelDisplay: "class", arrSeq: 0, matchCount: 0,
  pairHist: {}, oppHist: {}, lastResults: null, sessionDate: null,
  queue: [], active: [], resting: [], planned: [], planSeq: 0,
  playersSort: { key: "name", dir: 1 }, playerFilter: "all",
  branding: { name: "", logo: null }, tournaments: [], liveSync: false,
};
let S = { players: [] };
let uiImportOpen = false;
let editCourt = null; // id of the court currently being edited (swap players)
let Tournaments = null; // tournaments module instance

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
  if (data.kv && data.kv.tierVersion !== 2) S.levelDisplay = "class"; // re-grade to letter system once
  S.tierVersion = 2;
  S.branding = { name: (S.branding && S.branding.name) || "", logo: (S.branding && S.branding.logo) || null };
  S.pairHist = S.pairHist || {}; S.oppHist = S.oppHist || {};
  S.playersSort = S.playersSort || { key: "name", dir: 1 };
  if (!S.sessionDate) S.sessionDate = todayISO();
  if (!Array.isArray(S.queue)) S.queue = [];
  if (!Array.isArray(S.active)) S.active = [];
  if (!Array.isArray(S.resting)) S.resting = [];
  if (!Array.isArray(S.planned)) S.planned = [];
  // drop staged slots whose player is no longer present
  S.planned.forEach(p => { ["teamA", "teamB"].forEach(t => { p[t] = (p[t] || [null, null]).map(id => (id && byId(id) && byId(id).present) ? id : null); }); });
  // self-heal: every player marked present must be in the queue, resting, staged, or on a court
  const stagedIds = S.planned.flatMap(p => [...p.teamA, ...p.teamB]).filter(Boolean);
  const placed = new Set([...S.queue, ...S.resting, ...stagedIds, ...S.active.flatMap(c => [...c.teamA, ...c.teamB])]);
  S.queue = S.queue.filter(id => byId(id) && byId(id).present);
  S.resting = S.resting.filter(id => byId(id) && byId(id).present);
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
  return `<span class="tchip" data-tier="${t.key}" title="${t.cls} · ${t.name}">${txt}</span>`;
}
function tierLegendHtml() {
  return TIERS.map((t, i) => {
    const hi = TIERS[i + 1] ? TIERS[i + 1].min : null;
    const range = i === 0 ? `under ${TIERS[1].min.toFixed(1)}`
      : (hi ? `${t.min.toFixed(1)}–${hi.toFixed(1)}` : `${t.min.toFixed(1)}+`);
    return `<div class="legendrow"><span class="tchip" data-tier="${t.key}">${t.name}</span>` +
      `<span class="legcls">Grade ${t.cls}</span><span class="legrange mono faint">${range}</span></div>`;
  }).join("");
}

const V = {
  home: document.getElementById("view-home"),
  tonight: document.getElementById("view-tonight"),
  players: document.getElementById("view-players"),
  tournaments: document.getElementById("view-tournaments"),
  how: document.getElementById("view-how"),
};
function render() { renderTonight(); renderPlayers(); }

/* ---------- state operations ---------- */
function addToList(p) { if (!p.present) { p.present = true; p.arr = nextArr(); S.queue.push(p.id); } }
function removeTonight(id) {
  const p = byId(id); if (p) p.present = false;
  S.queue = S.queue.filter(x => x !== id);
  S.resting = S.resting.filter(x => x !== id);
  save();
}
function skipTurn(id) { S.queue = S.queue.filter(x => x !== id); S.queue.push(id); save(); refreshLists(); }
function restPlayer(id) { S.queue = S.queue.filter(x => x !== id); if (!S.resting.includes(id)) S.resting.push(id); save(); renderTonight(); }
function backToQueue(id) { S.resting = S.resting.filter(x => x !== id); if (!S.queue.includes(id)) S.queue.push(id); save(); renderTonight(); }
function removeFromResting(id) { const p = byId(id); if (p) p.present = false; S.resting = S.resting.filter(x => x !== id); save(); renderTonight(); }
function swapCourtPlayer(courtId, team, idx, newId) {
  const court = S.active.find(c => c.id === courtId); if (!court) return;
  const oldId = court[team][idx]; if (newId === oldId) return;
  court[team][idx] = newId;
  S.queue = S.queue.filter(x => x !== newId);
  S.queue.push(oldId);
  save(); renderTonight();
}

/* ---------- staged "up next" matches ---------- */
function planById(id) { return S.planned.find(p => p.id === id); }
function planReady(plan) { return ![...plan.teamA, ...plan.teamB].some(x => !x); }
function addPlan() { S.planned.push({ id: "pl" + (++S.planSeq), teamA: [null, null], teamB: [null, null] }); save(); renderTonight(); }
function assignToSlot(id, planId, team, idx) {
  const plan = planById(planId); if (!plan) return;
  const prev = plan[team][idx];
  S.queue = S.queue.filter(x => x !== id);
  if (prev && prev !== id) S.queue.push(prev);
  plan[team][idx] = id;
  save(); renderTonight();
}
function unslot(planId, team, idx) {
  const plan = planById(planId); if (!plan) return;
  const pid = plan[team][idx]; plan[team][idx] = null;
  if (pid) S.queue.push(pid);
  save(); renderTonight();
}
function clearPlan(planId) {
  const plan = planById(planId); if (!plan) return;
  ["teamA", "teamB"].forEach(t => plan[t].forEach((id, i) => { if (id) { S.queue.push(id); plan[t][i] = null; } }));
  save(); renderTonight();
}
function removePlan(planId) {
  const plan = planById(planId); if (!plan) return;
  [...plan.teamA, ...plan.teamB].forEach(id => { if (id) S.queue.push(id); });
  S.planned = S.planned.filter(p => p.id !== planId);
  save(); renderTonight();
}
function autofillPlan(planId) {
  const plan = planById(planId); if (!plan) return;
  const slots = [["teamA", 0], ["teamA", 1], ["teamB", 0], ["teamB", 1]];
  const empties = slots.filter(([t, i]) => !plan[t][i]);
  if (!empties.length) return;
  const filled = [...plan.teamA, ...plan.teamB].filter(Boolean).map(byId);
  if (filled.length === 0) {
    const four = pickFoursome(S.queue, byId, QUEUE_WINDOW);
    if (four) {
      const pr = bestPairing(four.map(byId), 0, S.pairHist, S.oppHist);
      plan.teamA = [pr.teamA[0], pr.teamA[1]]; plan.teamB = [pr.teamB[0], pr.teamB[1]];
      S.queue = S.queue.filter(id => !four.includes(id));
      save(); renderTonight(); return;
    }
  }
  const anchorR = filled.length ? filled.reduce((s, p) => s + p.rating, 0) / filled.length : 3.5;
  const picks = [...S.queue].sort((a, b) => Math.abs(byId(a).rating - anchorR) - Math.abs(byId(b).rating - anchorR)).slice(0, empties.length);
  empties.forEach(([t, i], k) => { if (picks[k]) plan[t][i] = picks[k]; });
  S.queue = S.queue.filter(id => !picks.includes(id));
  save(); renderTonight();
}
function startPlanned(planId, num) {
  const plan = planById(planId); if (!plan || !planReady(plan)) return false;
  S.active.push({ id: "m" + (++S.matchCount), num, teamA: [plan.teamA[0], plan.teamA[1]], teamB: [plan.teamB[0], plan.teamB[1]], scoreA: 0, scoreB: 0 });
  S.planned = S.planned.filter(p => p.id !== planId);
  return true;
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
  // start-on-finish: load the first ready staged match onto this freed court
  const ready = S.planned.find(planReady);
  if (ready) startPlanned(ready.id, court.num);
  save(); renderTonight(); renderPlayers();
}
function newSession() {
  S.players.forEach(p => { p.present = false; p.gamesTonight = 0; p.lastRound = -99; });
  S.queue = []; S.active = []; S.resting = []; S.planned = []; S.lastResults = null;
  S.matchCount = 0; S.arrSeq = 0;
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
    <div class="row" style="gap:10px;align-items:center">
      <label class="field" style="flex-direction:row;align-items:center;gap:7px;font-size:12px">
        <span>Courts</span><select id="courtSel" style="padding:6px 9px;font-size:14px;font-family:var(--fmono)">${[1,2,3,4,5,6,7,8].map(n => `<option ${n === S.courts ? "selected" : ""}>${n}</option>`).join("")}</select></label>
      <label class="field" style="flex-direction:row;align-items:center;gap:7px;font-size:12px">
        <span>Day</span><input type="date" id="sessionDate" value="${S.sessionDate}" style="padding:6px 9px;font-size:13px"></label>
    </div>
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

  // Up next — staged matches you build by hand
  const freeNum = free[0] || null;
  html += `<div class="stack" style="gap:10px">
    <div class="row spread wrap" style="align-items:center;gap:8px">
      <div class="eyebrow">Up next · build the next games</div>
      <button class="btn sm" id="addPlan">+ Add next game</button>
    </div>
    ${S.planned.length
      ? `<div class="courts">${S.planned.map((p, i) => plannedCard(p, i + 1, freeNum)).join("")}</div>`
      : `<p class="tiny faint" style="margin:0">No games staged. Tap “Add next game”, then drag players from the queue into the slots (or use the ＋ menu, or Auto-fill).</p>`}
  </div>`;

  // Queue
  html += `<div class="card pad stack">
    <div class="row spread wrap">
      <div class="eyebrow">In the queue · <span id="queueCount">${S.queue.length}</span> waiting</div>
      <button class="btn ghost sm" id="newSession">New session</button>
    </div>
    <p class="tiny muted" style="margin:0">Top of the queue plays next. Drag <b>⠿</b> to reorder · <b>⤓</b> skip to the back · <b>Rest</b> to sit out · <b>×</b> to remove.</p>
    <ol class="queue" id="queueList"></ol>
  </div>`;

  // Resting (sitting out)
  if (S.resting.length) {
    html += `<div class="card pad stack">
      <div class="eyebrow">Resting · ${S.resting.length}</div>
      <p class="tiny muted" style="margin:0">Set aside, not in line. Tap “Back in queue” when they're ready to play again.</p>
      <div class="stack" style="gap:6px">${S.resting.map(id => { const p = byId(id); return `
        <div class="restrow"><span class="qname">${esc(p.name)}</span>
          <span class="qlv num">${p.rating.toFixed(2)}</span>
          <button class="btn sm primary" data-back="${id}">Back in queue</button>
          <button class="qbtn qx" data-rmrest="${id}" title="Remove / left">×</button></div>`; }).join("")}</div>
    </div>`;
  }

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
  if (editCourt === court.id) return editCourtCard(court, A, B);
  const plRow = p => `<div class="pl"><span class="nm">${esc(p.name)}</span><span class="lv">${p.rating.toFixed(2)}</span></div>`;
  return `<div class="court" data-court-id="${court.id}">
    <div class="court-hd"><span class="cn">Court ${court.num}</span><span class="cavg">~${avg.toFixed(1)} level</span>
      <button class="editbtn" data-edit="${court.id}" title="Swap players">Edit</button></div>
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
function editCourtCard(court, A, B) {
  const waiting = S.queue.map(byId);
  const slot = (team, idx, cur) => {
    const opts = [cur, ...waiting];
    return `<select class="swapsel" data-court="${court.id}" data-team="${team}" data-idx="${idx}">` +
      opts.map(p => `<option value="${p.id}" ${p.id === cur.id ? "selected" : ""}>${esc(p.name)} (${p.rating.toFixed(2)})</option>`).join("") +
      `</select>`;
  };
  return `<div class="court editing" data-court-id="${court.id}">
    <div class="court-hd"><span class="cn">Court ${court.num} · editing</span>
      <button class="editbtn" data-donedit="${court.id}">Done</button></div>
    <div class="team"><div class="teamtag">Team 1</div>${slot("teamA", 0, A[0])}${slot("teamA", 1, A[1])}</div>
    <div class="vs">VS</div>
    <div class="team b"><div class="teamtag">Team 2</div>${slot("teamB", 0, B[0])}${slot("teamB", 1, B[1])}</div>
    <div class="court-foot"><p class="tiny faint" style="margin:0">Pick a waiting player to swap someone in. The player you replace goes to the back of the queue.${waiting.length ? "" : " (No one is waiting to swap in.)"}</p></div>
  </div>`;
}
function plannedCard(plan, n, freeNum) {
  const slotCell = (team, idx) => {
    const pid = plan[team][idx];
    if (pid) {
      const p = byId(pid);
      return `<div class="pslot filled"><span class="pslotname">${esc(p.name)}</span><span class="pslotlv num">${p.rating.toFixed(2)}</span>` +
        `<button class="pslotx" data-unslot="${plan.id}:${team}:${idx}" title="Remove">×</button></div>`;
    }
    const opts = `<option value="">＋ add</option>` +
      S.queue.map(id => { const q = byId(id); return `<option value="${id}">${esc(q.name)} (${q.rating.toFixed(2)})</option>`; }).join("");
    return `<div class="pslot empty" data-plan="${plan.id}" data-team="${team}" data-idx="${idx}">` +
      `<select class="slotsel" data-plan="${plan.id}" data-team="${team}" data-idx="${idx}">${opts}</select></div>`;
  };
  const filledCount = [...plan.teamA, ...plan.teamB].filter(Boolean).length;
  const ready = filledCount === 4;
  let foot;
  if (ready && freeNum) foot = `<button class="btn cta sm" data-startplan="${plan.id}" data-num="${freeNum}">Start on Court ${freeNum} →</button>`;
  else if (ready) foot = `<span class="tiny" style="color:var(--good);font-weight:700">Ready · starts when a court opens</span>`;
  else foot = `<button class="btn sm" data-autofill="${plan.id}" ${S.queue.length < (4 - filledCount) ? "disabled" : ""}>Auto-fill ${4 - filledCount} from queue</button>`;
  return `<div class="court plan" data-plan="${plan.id}">
    <div class="court-hd"><span class="cn">Up next ${n}</span>
      ${filledCount ? `<button class="editbtn" data-clearplan="${plan.id}">Clear</button>` : ""}
      <button class="editbtn plan-x" data-removeplan="${plan.id}" title="Remove this game">×</button></div>
    <div class="team"><div class="teamtag">Team 1</div>${slotCell("teamA", 0)}${slotCell("teamA", 1)}</div>
    <div class="vs">VS</div>
    <div class="team b"><div class="teamtag">Team 2</div>${slotCell("teamB", 0)}${slotCell("teamB", 1)}</div>
    <div class="court-foot">${foot}</div>
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
    return `<li class="qrow" data-id="${id}">
      <span class="qhandle" title="Drag to reorder" aria-label="Drag to reorder">⠿</span>
      <span class="qpos num">${i + 1}</span>
      <span class="qname">${esc(p.name)}</span>
      <span class="qlv num">${p.rating.toFixed(2)}</span>
      <span class="qgames num faint">${p.gamesTonight || 0}g</span>
      <span class="qacts">
        <button class="qbtn" data-skip="${id}" title="Skip turn — send to the back">⤓</button>
        <button class="qbtn" data-rest="${id}" title="Sit out (rest)">Rest</button>
        <button class="qbtn qx" data-rm="${id}" title="Remove / left for the night">×</button>
      </span></li>`;
  }).join("");
  enableDrag(list);
}
function enableDrag(list) {
  list.querySelectorAll(".qhandle").forEach(h => h.addEventListener("pointerdown", e => startDrag(e, h)));
}
function startDrag(e, handle) {
  e.preventDefault();
  const row = handle.closest(".qrow");
  const id = row.dataset.id;
  row.classList.add("dragsrc");
  const ghost = document.createElement("div");
  ghost.className = "dragghost";
  ghost.textContent = byId(id).name;
  document.body.appendChild(ghost);
  moveGhost(ghost, e);
  handle.setPointerCapture(e.pointerId);
  const onMove = ev => {
    moveGhost(ghost, ev);
    const vh = window.innerHeight;
    if (ev.clientY < 70) window.scrollBy(0, -12);
    else if (ev.clientY > vh - 70) window.scrollBy(0, 12);
    document.querySelectorAll(".pslot.over").forEach(s => s.classList.remove("over"));
    const slot = slotUnder(ev);
    if (slot) slot.classList.add("over");
  };
  const onUp = ev => {
    handle.removeEventListener("pointermove", onMove);
    handle.removeEventListener("pointerup", onUp);
    ghost.remove();
    row.classList.remove("dragsrc");
    document.querySelectorAll(".pslot.over").forEach(s => s.classList.remove("over"));
    const slot = slotUnder(ev);
    if (slot) { assignToSlot(id, slot.dataset.plan, slot.dataset.team, parseInt(slot.dataset.idx, 10)); return; }
    const l = document.getElementById("queueList");
    if (l) {
      const rows = [...l.querySelectorAll(".qrow")].filter(r => r.dataset.id !== id);
      let idx = rows.length;
      for (let k = 0; k < rows.length; k++) { const b = rows[k].getBoundingClientRect(); if (ev.clientY < b.top + b.height / 2) { idx = k; break; } }
      const cur = S.queue.indexOf(id);
      if (cur >= 0) { S.queue.splice(cur, 1); S.queue.splice(idx, 0, id); save(); refreshLists(); }
    }
  };
  handle.addEventListener("pointermove", onMove);
  handle.addEventListener("pointerup", onUp);
}
function moveGhost(g, ev) { g.style.left = ev.clientX + "px"; g.style.top = ev.clientY + "px"; }
function slotUnder(ev) {
  const el = document.elementFromPoint(ev.clientX, ev.clientY);
  return el && el.closest ? el.closest(".pslot.empty") : null;
}
function statusOf(id) {
  const c = S.active.find(c => c.teamA.includes(id) || c.teamB.includes(id));
  if (c) return { label: `Court ${c.num}`, kind: "playing" };
  if (S.planned.some(p => p.teamA.includes(id) || p.teamB.includes(id))) return { label: "Up next", kind: "upnext" };
  const qi = S.queue.indexOf(id);
  if (qi >= 0) return { label: `Waiting #${qi + 1}`, kind: "waiting" };
  if (S.resting.includes(id)) return { label: "Resting", kind: "resting" };
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
  let list = [...S.players];
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
    <div><div class="eyebrow">Club roster</div><h2 style="font-size:22px">Players</h2></div>
    <div class="row spread wrap" style="gap:10px">
      <span class="tiny muted" style="font-weight:700">${S.players.length} player${S.players.length === 1 ? "" : "s"}</span>
      <div class="row" style="gap:8px;align-items:center">
        <span class="tiny muted" style="font-weight:700">Show as</span>
        <div class="seg" role="group" aria-label="level display">
          <button data-disp="class" aria-pressed="${S.levelDisplay === 'class'}">Grade</button>
          <button data-disp="text" aria-pressed="${S.levelDisplay === 'text'}">Name</button>
        </div>
      </div>
    </div>
    <p class="tiny faint" style="margin:0">Tap a player to edit their profile.</p>
    ${importPanelHtml()}
    <div class="card"><div class="tablewrap"><table>
      <thead><tr>
        ${th("name", "Player")}<th>Gender</th><th>Grade</th>${th("rating", "Level", true)}<th class="r">Age</th>
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
      <label class="field">Gender<select id="np_gender"><option value="">—</option><option value="f">Women</option><option value="m">Men</option></select></label>
      <label class="field">Starting level<input type="number" id="np_lvl" value="3.50" step="0.05" min="1.5" max="6" style="width:112px"></label>
      <label class="field">Age<input type="number" id="np_age" placeholder="—" min="4" max="99" style="width:84px"></label>
      <label class="field">If no age<select id="np_agegrp"><option value="junior">Junior</option><option value="adult" selected>Adult</option><option value="senior">Senior</option></select></label>
      <button class="btn primary" type="submit">Add player</button>
      <button class="btn ghost" type="button" id="np_cancel">Cancel</button>
    </form>`;
  wirePlayers(); wireImport(el);
}
function ageGroupLabel(g) { return { junior: "Junior", adult: "Adult", senior: "Senior" }[g] || "Adult"; }
function ageDisplay(p) { return (p.age != null && p.age !== "") ? p.age : ageGroupLabel(p.ageGroup || "adult"); }
function genderChip(g) {
  if (g === "f") return `<span class="gchip f" title="Women">W</span>`;
  if (g === "m") return `<span class="gchip m" title="Men">M</span>`;
  return `<span class="gchip" title="Not set">—</span>`;
}
function playerRow(p) {
  return `<tr class="prow" data-pid="${p.id}" tabindex="0">
    <td><b>${esc(p.name)}</b>${p.present ? ` <span class="tiny" style="color:var(--court)">• here</span>` : ""}</td>
    <td>${genderChip(p.gender)}</td>
    <td>${tierChip(p.rating)}</td>
    <td class="r"><span class="level">${p.rating.toFixed(2)}</span></td>
    <td class="r num">${ageDisplay(p)}</td>
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
    <p class="tiny muted" style="margin:0">One member per line — <span class="mono">Name, Level, Gender</span> (level and gender optional). Load from a Google Sheet, or paste below.</p>
    <div class="row wrap" style="gap:8px;align-items:flex-end">
      <label class="field grow">Google Sheets link
        <input type="text" id="sheetUrl" placeholder="Paste a Google Sheets link…" autocomplete="off"></label>
      <button class="btn sm" id="sheetLoad">Load</button>
    </div>
    <span class="tiny faint" id="sheetStatus"></span>
    <textarea id="importText" placeholder="Maria Chen, 3.5, Women&#10;James Reyes, 4.0, Men&#10;Priya Singh&#10;Tom Flores, 2.5"></textarea>
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
  const refresh = () => {
    const rows = parseRoster(text.value);
    const names = new Set(S.players.map(p => p.name.toLowerCase()));
    const fresh = rows.filter(r => !names.has(r.name.toLowerCase()));
    const dup = rows.length - fresh.length;
    count.textContent = `${rows.length} found · ${fresh.length} new${dup ? ` · ${dup} already in roster` : ""}`;
    return rows;
  };
  text.addEventListener("input", refresh);
  const close = () => { uiImportOpen = false; renderPlayers(); };
  panel.querySelector("#importClose").addEventListener("click", close);
  panel.querySelector("#importCancel").addEventListener("click", close);
  panel.querySelector("#sheetLoad").addEventListener("click", async () => {
    const url = panel.querySelector("#sheetUrl").value.trim();
    const status = panel.querySelector("#sheetStatus");
    if (!url) return;
    status.textContent = "Loading…"; status.style.color = "var(--muted)";
    try {
      text.value = await fetchSheet(url);
      refresh();
      status.textContent = "Loaded from the sheet — check the count, then Import."; status.style.color = "var(--good)";
    } catch (e) {
      status.textContent = "Couldn't load — set the sheet to “Anyone with the link can view”, or File → Share → Publish to web → CSV and paste that link.";
      status.style.color = "var(--bad)";
    }
  });
  panel.querySelector("#importDo").addEventListener("click", () => {
    const rows = parseRoster(text.value);
    if (!rows.length) { close(); return; }
    runImport(rows);
  });
  const openBtn = el.querySelector("#openImport");
  if (openBtn) openBtn.addEventListener("click", () => { uiImportOpen = true; renderPlayers(); panel.scrollIntoView?.({ behavior: "smooth", block: "nearest" }); });
  if (uiImportOpen) text.focus();
}

/* ---------- Google Sheets + merge import ---------- */
function sheetCsvUrl(url) {
  url = url.trim();
  if (/output=csv|format=csv|tqx=out:csv/.test(url)) return url;
  const m = url.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  if (m) {
    const gidM = url.match(/[#&?]gid=(\d+)/);
    return `https://docs.google.com/spreadsheets/d/${m[1]}/gviz/tq?tqx=out:csv&gid=${gidM ? gidM[1] : "0"}`;
  }
  return url;
}
async function fetchSheet(url) {
  const res = await fetch(sheetCsvUrl(url));
  if (!res.ok) throw new Error("HTTP " + res.status);
  return res.text();
}
function runImport(rows) {
  if (!rows.length) return;
  const byName = new Map(S.players.map(p => [p.name.toLowerCase(), p]));
  const fresh = [], matches = [];
  rows.forEach(r => {
    const ex = byName.get(r.name.toLowerCase());
    if (ex) matches.push({ row: r, existing: ex }); else fresh.push(r);
  });
  if (!matches.length) { applyImport(fresh, []); return; }
  showMergeModal(fresh, matches);
}
function applyImport(fresh, mergeThese) {
  fresh.forEach(r => S.players.push(makePlayer(r.name, r.rating, r.gender)));
  mergeThese.forEach(({ row, existing }) => {
    existing.rating = row.rating;
    if (row.gender) existing.gender = row.gender;
  });
  uiImportOpen = false; save(); render();
}
function showMergeModal(fresh, matches) {
  const overlay = document.createElement("div");
  overlay.className = "modal";
  overlay.innerHTML = `<div class="modal-backdrop"></div>
    <div class="modal-card">
      <div class="row spread" style="align-items:center"><h2 style="font-size:18px">Review import</h2>
        <button class="btn ghost sm" data-x>Cancel</button></div>
      <p class="tiny muted" style="margin:0"><b>${fresh.length}</b> new member${fresh.length !== 1 ? "s" : ""} will be added.
        <b>${matches.length}</b> name${matches.length !== 1 ? "s" : ""} already in your roster — tick the ones to <b>merge</b> (updates their level &amp; gender from the sheet); unticked are left unchanged.</p>
      <div class="row" style="gap:8px"><button class="btn ghost sm" data-all>Merge all</button><button class="btn ghost sm" data-none>Skip all</button></div>
      <div class="stack" style="gap:6px;max-height:42vh;overflow:auto">${matches.map((m, i) => mergeRowHtml(m, i)).join("")}</div>
      <div class="row" style="justify-content:flex-end;gap:8px">
        <button class="btn primary" data-confirm>Confirm import</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  const checks = () => [...overlay.querySelectorAll("[data-merge]")];
  overlay.querySelector("[data-x]").addEventListener("click", close);
  overlay.querySelector(".modal-backdrop").addEventListener("click", close);
  overlay.querySelector("[data-all]").addEventListener("click", () => checks().forEach(c => c.checked = true));
  overlay.querySelector("[data-none]").addEventListener("click", () => checks().forEach(c => c.checked = false));
  overlay.querySelector("[data-confirm]").addEventListener("click", () => {
    const toMerge = matches.filter((m, i) => overlay.querySelector(`[data-merge="${i}"]`).checked);
    close();
    applyImport(fresh, toMerge);
  });
}
function mergeRowHtml(m, i) {
  const ex = m.existing, row = m.row, ch = [];
  if (Number(ex.rating).toFixed(2) !== Number(row.rating).toFixed(2)) ch.push(`level ${Number(ex.rating).toFixed(2)}→${Number(row.rating).toFixed(2)}`);
  if (row.gender && row.gender !== ex.gender) ch.push(`gender ${ex.gender === "f" ? "W" : ex.gender === "m" ? "M" : "—"}→${row.gender === "f" ? "W" : "M"}`);
  return `<label class="mergerow"><input type="checkbox" data-merge="${i}" checked>
    <span class="grow"><b>${esc(ex.name)}</b> <span class="tiny muted">${ch.length ? ch.join(" · ") : "no change"}</span></span></label>`;
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
    <div><div class="eyebrow">Grades</div><h3>From a number to a grade</h3></div>
    <p>The engine works in precise numbers (like <span class="k">3.80</span>) so a level drifts up or down game by game as players win or lose. Those numbers map to eight grades, <b>D2</b> (lowest) up to <b>A1</b> (highest):</p>
    <div class="tierlegend">${tierLegendHtml()}</div>
    <p class="tiny muted">Switch <b>Grade</b> / <b>Name</b> on the Players tab. The roster lists alphabetically by default — tap <b>Level</b> to sort by rating instead.</p>
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
  q("#courtSel") && q("#courtSel").addEventListener("change", e => {
    S.courts = Math.max(1, parseInt(e.target.value, 10)) || 2; save(); renderTonight();
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
    const sk = e.target.closest("[data-skip]"); if (sk) { skipTurn(sk.dataset.skip); return; }
    const rs = e.target.closest("[data-rest]"); if (rs) { restPlayer(rs.dataset.rest); return; }
    const rm = e.target.closest("[data-rm]"); if (rm) { removeTonight(rm.dataset.rm); refreshLists(); updateSearch(); }
  });
  // resting controls
  el.querySelectorAll("[data-back]").forEach(b => b.addEventListener("click", () => backToQueue(b.dataset.back)));
  el.querySelectorAll("[data-rmrest]").forEach(b => b.addEventListener("click", () => { removeFromResting(b.dataset.rmrest); updateSearch(); }));
  // per-court edit / swap
  el.querySelectorAll("[data-edit]").forEach(b => b.addEventListener("click", () => { editCourt = b.dataset.edit; renderTonight(); }));
  el.querySelectorAll("[data-donedit]").forEach(b => b.addEventListener("click", () => { editCourt = null; renderTonight(); }));
  el.querySelectorAll(".swapsel").forEach(s => s.addEventListener("change", () => swapCourtPlayer(s.dataset.court, s.dataset.team, parseInt(s.dataset.idx, 10), s.value)));
  // staged "up next"
  q("#addPlan") && q("#addPlan").addEventListener("click", addPlan);
  el.querySelectorAll("[data-autofill]").forEach(b => b.addEventListener("click", () => autofillPlan(b.dataset.autofill)));
  el.querySelectorAll("[data-clearplan]").forEach(b => b.addEventListener("click", () => clearPlan(b.dataset.clearplan)));
  el.querySelectorAll("[data-removeplan]").forEach(b => b.addEventListener("click", () => removePlan(b.dataset.removeplan)));
  el.querySelectorAll("[data-unslot]").forEach(b => b.addEventListener("click", () => { const [pid, team, idx] = b.dataset.unslot.split(":"); unslot(pid, team, parseInt(idx, 10)); }));
  el.querySelectorAll("[data-startplan]").forEach(b => b.addEventListener("click", () => { if (startPlanned(b.dataset.startplan, parseInt(b.dataset.num, 10))) { save(); renderTonight(); } }));
  el.querySelectorAll(".slotsel").forEach(s => s.addEventListener("change", () => { if (s.value) assignToSlot(s.value, s.dataset.plan, s.dataset.team, parseInt(s.dataset.idx, 10)); }));
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
  el.querySelectorAll("[data-disp]").forEach(b => b.addEventListener("click", () => { S.levelDisplay = b.dataset.disp; save(); renderPlayers(); renderTonight(); }));

  el.querySelectorAll(".prow").forEach(r => {
    r.addEventListener("click", () => openProfile(r.dataset.pid));
    r.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openProfile(r.dataset.pid); } });
  });

  const addBtn = el.querySelector("#addPlayer"), form = el.querySelector("#addForm");
  addBtn.addEventListener("click", () => { form.hidden = !form.hidden; if (!form.hidden) el.querySelector("#np_name").focus(); });
  el.querySelector("#np_cancel").addEventListener("click", () => { form.hidden = true; });
  form.addEventListener("submit", e => {
    e.preventDefault();
    const name = el.querySelector("#np_name").value.trim();
    if (!name) return;
    const r = parseFloat(el.querySelector("#np_lvl").value) || 3.5;
    const p = makePlayer(name, r, el.querySelector("#np_gender").value || null);
    const ageV = el.querySelector("#np_age").value.trim();
    p.age = ageV === "" ? null : Math.max(4, Math.min(99, parseInt(ageV, 10) || 0));
    p.ageGroup = el.querySelector("#np_agegrp").value || "adult";
    S.players.push(p);
    save(); renderPlayers(); renderTonight();
  });
  el.querySelector("#clearAll").addEventListener("click", async () => {
    if (!confirm("Clear ALL members, ratings and tonight's data from this device? This can't be undone.")) return;
    try { await store.clearAll(); } catch (e) {}
    S = { players: [], ...DEFAULTS, pairHist: {}, oppHist: {}, queue: [], active: [], sessionDate: todayISO() };
    render();
  });
}

function openProfile(pid) {
  const p = S.players.find(x => x.id === pid);
  if (!p) return;
  const t = tierOf(p.rating);
  const overlay = document.createElement("div");
  overlay.className = "modal";
  overlay.innerHTML = `<div class="modal-backdrop"></div>
    <div class="modal-card">
      <div class="row spread" style="align-items:center">
        <h2 style="font-size:18px">Player profile</h2>
        <button class="btn ghost sm" data-x>Close</button>
      </div>
      <label class="field">Name<input type="text" id="pf_name" value="${esc(p.name)}" autocomplete="off"></label>
      <div class="row wrap" style="gap:10px">
        <label class="field">Gender
          <select id="pf_gender">
            <option value=""${!p.gender ? " selected" : ""}>—</option>
            <option value="f"${p.gender === "f" ? " selected" : ""}>Women</option>
            <option value="m"${p.gender === "m" ? " selected" : ""}>Men</option>
          </select></label>
        <label class="field">Level<input type="number" id="pf_lvl" value="${p.rating.toFixed(2)}" step="0.05" min="1.5" max="6" style="width:110px"></label>
      </div>
      <div class="row wrap" style="gap:10px;align-items:flex-end">
        <label class="field">Age<input type="number" id="pf_age" value="${p.age != null ? p.age : ""}" placeholder="—" min="4" max="99" style="width:96px"></label>
        <label class="field">If no age
          <select id="pf_agegrp">
            <option value="junior"${(p.ageGroup || "adult") === "junior" ? " selected" : ""}>Junior</option>
            <option value="adult"${(p.ageGroup || "adult") === "adult" ? " selected" : ""}>Adult</option>
            <option value="senior"${(p.ageGroup || "adult") === "senior" ? " selected" : ""}>Senior</option>
          </select></label>
        <span class="tiny muted" style="padding-bottom:8px">Grade ${t.cls} · ${t.name}</span>
      </div>
      <div class="row spread" style="gap:8px;margin-top:4px">
        <button class="btn ghost sm" data-remove style="color:var(--bad)">Remove player</button>
        <button class="btn primary" data-save>Save</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const close = () => overlay.remove();
  overlay.querySelector("[data-x]").addEventListener("click", close);
  overlay.querySelector(".modal-backdrop").addEventListener("click", close);
  overlay.querySelector("[data-save]").addEventListener("click", () => {
    const name = overlay.querySelector("#pf_name").value.trim();
    if (name) p.name = name;
    p.gender = overlay.querySelector("#pf_gender").value || null;
    const r = parseFloat(overlay.querySelector("#pf_lvl").value);
    if (isFinite(r)) p.rating = Math.max(1.5, Math.min(6, Math.round(r * 100) / 100));
    const ageV = overlay.querySelector("#pf_age").value.trim();
    p.age = ageV === "" ? null : Math.max(4, Math.min(99, parseInt(ageV, 10) || 0));
    p.ageGroup = overlay.querySelector("#pf_agegrp").value || "adult";
    close();
    save(); renderPlayers(); renderTonight();
  });
  overlay.querySelector("[data-remove]").addEventListener("click", () => {
    if (!confirm(`Remove ${p.name} from the roster?`)) return;
    S.players = S.players.filter(x => x.id !== pid);
    close();
    save(); renderPlayers(); renderTonight();
  });
}

/* ---------- tabs + theme + courts ---------- */
const HOME_ITEMS = [
  { k: "tonight", title: "Open Play", desc: "Run tonight's session — queue, courts, scores and live ratings." },
  { k: "tournaments", title: "Tournament", desc: "Round-robins and brackets, with standings and the quotient tiebreak." },
  { k: "players", title: "Players", desc: "Your club roster, with D2–A1 grades and reliability." },
  { k: "how", title: "How it works", desc: "Ratings, grades and the queue, explained." },
  { k: "settings", title: "Settings", desc: "Club name, logo and cloud sync." },
];
const HOME_ICONS = {
  tonight: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M4.6 7.5c4.5 2.2 4.5 6.8 0 9M19.4 7.5c-4.5 2.2-4.5 6.8 0 9"/></svg>`,
  tournaments: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 4h10v4a5 5 0 0 1-10 0z"/><path d="M7 6H4v1a3 3 0 0 0 3 3M17 6h3v1a3 3 0 0 1-3 3"/><path d="M9.5 20h5M12 14v6"/></svg>`,
  players: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="8" r="3"/><circle cx="17" cy="9" r="2.4"/><path d="M3.5 19a5.5 5.5 0 0 1 11 0M15 19a4.5 4.5 0 0 1 5.5-4.4"/></svg>`,
  how: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M9.6 9.5a2.4 2.4 0 0 1 4.6 1.1c0 1.6-2.2 1.9-2.2 3.4"/><path d="M12 17h.01"/></svg>`,
  settings: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M12 3v2.5M12 18.5V21M3 12h2.5M18.5 12H21M5.6 5.6l1.8 1.8M16.6 16.6l1.8 1.8M18.4 5.6l-1.8 1.8M7.4 16.6l-1.8 1.8"/></svg>`,
};
const TITLES = { home: "Home", tonight: "Open Play", players: "Players", tournaments: "Tournament", how: "How it works" };
function renderHome() {
  const name = (S.branding && S.branding.name || "").trim();
  V.home.innerHTML = `<div><div class="eyebrow">${name ? esc(name) : "Court Sense"}</div><h2 style="font-size:22px">What would you like to do?</h2></div>
    <div class="dash">` + HOME_ITEMS.map(it => `
      <button class="dashcard" data-go="${it.k}">
        <span class="dashicon ${it.k}">${HOME_ICONS[it.k]}</span>
        <span class="dashtitle">${it.title}</span>
        <span class="dashchev">→</span>
      </button>`).join("") + `</div>`;
  V.home.querySelectorAll("[data-go]").forEach(b => b.addEventListener("click", () => {
    const k = b.dataset.go;
    if (k === "settings") { document.getElementById("settingsBtn").click(); return; }
    setView(k);
  }));
}
function setView(v) {
  for (const k in V) V[k].hidden = (k !== v);
  const sub = document.getElementById("subnav");
  if (v === "home") { sub.hidden = true; }
  else { sub.hidden = false; document.getElementById("subtitle").textContent = TITLES[v] || ""; }
  if (v === "home") renderHome();
  if (v === "how") renderHow();
  if (v === "players") renderPlayers();
  if (v === "tournaments" && Tournaments) Tournaments.render();
  try { location.hash = v; } catch (e) {}
  window.scrollTo({ top: 0, behavior: "instant" });
}
/* ---------- branding ---------- */
function applyBranding() {
  const name = (S.branding.name || "").trim();
  const logo = S.branding.logo;
  const nameEl = document.getElementById("brandName");
  const ball = document.getElementById("brandBall");
  if (nameEl) nameEl.textContent = name || "Court Sense";
  if (ball) {
    if (logo) { ball.classList.add("haslogo"); ball.innerHTML = `<img src="${logo}" alt="">`; }
    else { ball.classList.remove("haslogo"); ball.innerHTML = ""; }
  }
  try { document.title = name ? `${name} · Court Sense` : "Court Sense"; } catch (e) {}
}
function wireBranding() {
  const modal = document.getElementById("brandingModal");
  const nameInput = document.getElementById("brandNameInput");
  const preview = document.getElementById("brandLogoPreview");
  const fileInput = document.getElementById("brandLogoInput");
  function renderPreview() {
    if (S.branding.logo) { preview.classList.remove("empty"); preview.innerHTML = `<img src="${S.branding.logo}" alt="">`; }
    else { preview.classList.add("empty"); preview.innerHTML = ""; }
  }
  const open = () => { nameInput.value = S.branding.name || ""; renderPreview(); modal.hidden = false; };
  const close = () => { modal.hidden = true; };
  document.getElementById("settingsBtn").addEventListener("click", open);
  document.getElementById("brandClose").addEventListener("click", close);
  document.getElementById("brandDone").addEventListener("click", close);
  document.getElementById("brandBackdrop").addEventListener("click", close);
  const sync = document.getElementById("syncNow");
  if (sync) sync.addEventListener("click", doSync);
  const live = document.getElementById("liveSyncToggle");
  if (live) {
    live.checked = !!S.liveSync;
    live.disabled = !supaConfigured();
    live.addEventListener("change", () => setLiveSync(live.checked));
  }
  nameInput.addEventListener("input", () => { S.branding.name = nameInput.value; save(); applyBranding(); });
  document.getElementById("brandLogoRemove").addEventListener("click", () => { S.branding.logo = null; save(); applyBranding(); renderPreview(); });
  fileInput.addEventListener("change", e => {
    const file = e.target.files && e.target.files[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const max = 256; let w = img.width, h = img.height;
        const scale = Math.min(1, max / Math.max(w, h)); w = Math.round(w * scale); h = Math.round(h * scale);
        const c = document.createElement("canvas"); c.width = w; c.height = h;
        c.getContext("2d").drawImage(img, 0, 0, w, h);
        try { S.branding.logo = c.toDataURL("image/png"); } catch (err) { S.branding.logo = reader.result; }
        save(); applyBranding(); renderPreview();
      };
      img.onerror = () => { S.branding.logo = reader.result; save(); applyBranding(); renderPreview(); };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
    e.target.value = "";
  });
}
async function doSync() {
  const el = document.getElementById("syncStatus");
  const btn = document.getElementById("syncNow");
  if (el) { el.textContent = "Syncing…"; el.style.color = "var(--muted)"; }
  if (btn) btn.disabled = true;
  try {
    const res = await supaSync(S);
    save();
    renderTonight(); renderPlayers(); if (Tournaments) Tournaments.render();
    const time = new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    if (el) { el.textContent = `Synced · ${res.members} members, ${res.tournaments} tournaments · ${time}`; el.style.color = "var(--good)"; }
  } catch (e) {
    if (el) { el.textContent = "Sync failed — " + (e && e.message ? e.message.slice(0, 90) : e); el.style.color = "var(--bad)"; }
  } finally {
    if (btn) btn.disabled = false;
  }
}

/* ---------- live sync (continuous, collaborative) ---------- */
const LIVE_SYNC_MS = 4000;
let liveTimer = null, liveBusy = false, livePendingRender = false;
function liveStatus(text, color) { const el = document.getElementById("syncStatus"); if (el) { el.textContent = text; el.style.color = color || "var(--muted)"; } }
function editingTournament() {
  const a = document.activeElement;
  return a && /^(INPUT|SELECT|TEXTAREA)$/.test(a.tagName) && V.tournaments.contains(a);
}
async function liveTick() {
  if (liveBusy) return;
  if (!navigator.onLine) { liveStatus("Offline — will sync when back online", "var(--muted)"); return; }
  liveBusy = true;
  try {
    const res = await supaSync(S);
    save();
    if (res.changed || livePendingRender) {
      if (editingTournament()) { livePendingRender = true; }       // don't yank a field mid-edit
      else { livePendingRender = false; renderTonight(); renderPlayers(); if (Tournaments) Tournaments.render(); }
    }
    const time = new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    liveStatus(`Live · in sync · ${time}`, "var(--good)");
  } catch (e) {
    liveStatus("Sync paused — " + (e && e.message ? e.message.slice(0, 70) : e), "var(--bad)");
  } finally {
    liveBusy = false;
  }
}
function startLiveSync() {
  if (liveTimer || !supaConfigured()) return;
  liveTick();
  liveTimer = setInterval(liveTick, LIVE_SYNC_MS);
}
function stopLiveSync() { if (liveTimer) { clearInterval(liveTimer); liveTimer = null; } }
function setLiveSync(on) {
  S.liveSync = !!on; save();
  if (on) startLiveSync(); else { stopLiveSync(); liveStatus("Live sync off", "var(--muted)"); }
}
function wireStatic() {
  document.getElementById("homeBtn").addEventListener("click", () => setView("home"));
  const brand = document.querySelector("header .brand");
  if (brand) { brand.style.cursor = "pointer"; brand.title = "Home"; brand.addEventListener("click", () => setView("home")); }
  const themeBtn = document.getElementById("themeBtn");
  themeBtn.addEventListener("click", () => {
    const now = document.documentElement.getAttribute("data-theme");
    const sysDark = matchMedia("(prefers-color-scheme:dark)").matches;
    const next = now ? (now === "dark" ? "light" : "dark") : (sysDark ? "light" : "dark");
    document.documentElement.setAttribute("data-theme", next);
    try { localStorage.setItem(THEME_KEY, next); } catch (e) {}
  });
  try { const t = localStorage.getItem(THEME_KEY); if (t) document.documentElement.setAttribute("data-theme", t); } catch (e) {}
}

/* ---------- boot ---------- */
(async function boot() {
  await load();
  wireStatic();
  wireBranding();
  applyBranding();
  Tournaments = createTournaments({ mount: V.tournaments, state: S, save, byId, tierChip });
  render();
  const start = (location.hash || "").replace("#", "");
  setView(["home", "tonight", "players", "tournaments", "how"].includes(start) ? start : "home");
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
  }
  if (S.liveSync && supaConfigured()) startLiveSync();
  window.addEventListener("online", () => { if (S.liveSync) startLiveSync(); });
  window.addEventListener("offline", () => liveStatus("Offline — will sync when back online", "var(--muted)"));
})();
