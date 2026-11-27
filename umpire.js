// Court Sense — umpire view. Read-only schedule + a big split-screen tap scorer.
// Shares the same on-device store and cloud sync as the organizer app, so scores
// an umpire records here show up in the organizer's "Playing now" and standings.
// It never edits the schedule, teams, or settings.
import * as store from "./store.js";
import { syncNow, configured } from "./sync.js";
import { tennisCfg, addTennisPoint, undoTennisPoint, pointLabel, isSuddenDeath } from "./tennis.js";

let S = { players: [], tournaments: [] };
let view = "courts";          // "courts" | "score"
let tid = null;               // selected tournament
let scoring = null;           // { did, mid } being scored
let wonShown = false;         // win overlay is up
let syncing = false, pollTimer = null, lastSync = 0, pushTimer = null;

const appEl = () => document.getElementById("app");
const esc = s => String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const byId = id => S.players.find(p => p.id === id);

/* ---------- state ---------- */
async function load() {
  let data; try { data = await store.loadAll(); } catch (e) { data = { players: [], kv: null }; }
  S = { players: data.players || [], ...(data.kv || {}) };
  S.tournaments = S.tournaments || [];
}
function kvSnap() { const { players, ...kv } = S; return kv; }
function save() { try { store.saveKV(kvSnap()); store.putPlayers(S.players); } catch (e) {} }
async function doSync() {
  if (!configured() || syncing) return false;
  syncing = true;
  let ok = false;
  try { await syncNow(S); S.tournaments = S.tournaments || []; ok = true; lastSync = Date.now(); } catch (e) {}
  syncing = false;
  return ok;
}
// Save locally right away (instant, shared with the organizer on this device), then
// push to the cloud on a short debounce. We never pull-merge mid-scoring — that would
// swap the match object out from under the umpire between taps — so the push is
// fire-and-forget while scoring; the Courts view pulls on its poll instead.
function commit() {
  save();
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => {
    doSync().then(() => { if (view !== "score" || !scoring) render(); });
  }, 1500);
}

/* ---------- lookups ---------- */
function curT() { return S.tournaments.find(t => t.id === tid) || S.tournaments[0] || null; }
function resolve() {
  const t = curT(); if (!t || !scoring) return null;
  for (const d of t.divisions) { const m = d.matches.find(x => x.id === scoring.mid); if (m) return { t, d, m }; }
  return null;
}
function teamName(d, teamId) {
  const tm = (d.teams || []).find(x => x.id === teamId);
  if (!tm) return "—";
  return (tm.players || []).map(pid => { const p = byId(pid); return p ? p.name : "?"; }).join(" / ") || "—";
}
function gradeKey(d) { return ((d.grade && d.grade[0]) || "d").toLowerCase(); }
function divLabel(d) {
  const cat = { mixed: "Mixed", womens: "Women's", mens: "Men's" }[d.category] || d.category || "";
  const disc = d.discipline === "singles" ? "Singles" : "Doubles";
  return `${cat} ${disc} · ${d.grade || ""}`.trim();
}
function liveMatches(t) {
  // on court now = started OR warming up, and not yet finished — matches the organizer's "Playing now"
  const out = [];
  (t.divisions || []).forEach(d => (d.matches || []).forEach(m => { if (m.a && m.b && (m.startedAt != null || m.warmupStart != null) && m.endedAt == null) out.push({ d, m }); }));
  return out.sort((x, y) => (x.m.court || 99) - (y.m.court || 99));
}
function upcoming(t) {
  const out = [];
  (t.divisions || []).forEach(d => (d.matches || []).forEach(m => { if (m.a && m.b && m.startedAt == null && m.endedAt == null) out.push({ d, m }); }));
  return out;
}

/* ---------- tennis display helpers ---------- */
function sidePt(m, side, cfg) {
  if (m.tInTb) return String(m["tb" + side] || 0);
  const a = m.tpA || 0, b = m.tpB || 0;
  if (a >= 3 && b >= 3 && a !== b) return side === (a > b ? "A" : "B") ? "Ad" : "40";
  return pointLabel(m[side === "A" ? "tpA" : "tpB"] || 0);
}
function stateLine(m, cfg) {
  if (m.tInTb) return `Tiebreak · first to 7`;
  const a = m.tpA || 0, b = m.tpB || 0;
  if (a >= 3 && b >= 3) {
    if (a === b) return isSuddenDeath(m, cfg) ? "Sudden death — next point wins" : "Deuce";
    const advSide = a > b ? "A" : "B", server = m.tServer || "A";
    return advSide === server ? "Advantage server" : "Advantage receiver";
  }
  return "";
}

/* ---------- render ---------- */
function render() {
  const t = curT();
  let h = `<div class="ump-head"><span class="ball"></span>
      <div><b>Court Sense</b><div class="role">Umpire</div></div>
      <span class="sp"></span>
      <button id="u-refresh">↻ Refresh</button></div>`;
  if (!t) {
    appEl().innerHTML = h + `<main><div class="u-empty">No tournament found on this device yet.<br>Tap Refresh to pull from the cloud.</div></main>`;
    wire();
    return;
  }
  h += `<div class="ump-tabs">
      <button data-v="courts" class="${view === "courts" ? "on" : ""}">Courts</button>
      <button data-v="score" class="${view === "score" ? "on" : ""}">Score</button></div>`;
  h += `<main>`;
  h += view === "courts" ? courtsHtml(t) : scoreHtml(t);
  h += `</main>`;
  appEl().innerHTML = h;
  if (view === "score" && scoring) appEl().insertAdjacentHTML("beforeend", scorerHtml());
  wire();
}

function courtsHtml(t) {
  const live = liveMatches(t);
  const courts = Math.max(1, t.courts || 1);
  let h = `<div class="u-eyebrow" style="margin-bottom:8px">${esc(t.name)} · on court now</div>`;
  if (!live.length) h += `<div class="u-empty">No matches are being played right now.</div>`;
  for (let n = 1; n <= courts; n++) {
    const x = live.find(l => (l.m.court || 0) === n) || (n <= live.length ? live.filter(l => !l.m.court)[0] : null);
    if (!x) { h += `<div class="u-card"><div class="u-row"><span class="u-court">Court ${n}</span><span class="u-sub" style="margin-left:auto">open</span></div></div>`; continue; }
    h += courtCard(t, n, x.d, x.m);
  }
  const next = upcoming(t).slice(0, 6);
  if (next.length) {
    h += `<div class="u-eyebrow" style="margin:16px 0 8px">Coming up</div>`;
    next.forEach(({ d, m }) => {
      h += `<div class="u-card gbar" style="--gb:var(--t-${gradeKey(d)})">
        <div class="u-sub">${esc(divLabel(d))}</div>
        <div class="u-teams">${esc(teamName(d, m.a))} <span class="u-vs">vs</span> ${esc(teamName(d, m.b))}</div></div>`;
    });
  }
  return h;
}
function courtCard(t, n, d, m) {
  const fmt = t.format === "tennis" ? "Tennis" : (t.format === "sets" ? "Sets" : "Race");
  const warming = m.startedAt == null && m.warmupStart != null;
  return `<div class="u-card gbar" style="--gb:var(--t-${gradeKey(d)})">
    <div class="u-row"><span class="u-court">Court ${n}</span>
      <span class="u-score">${warming ? `<span class="u-warm">● warming up</span>` : `${m.scoreA || 0}–${m.scoreB || 0}`}</span></div>
    <div class="u-sub">${esc(divLabel(d))} · ${fmt}</div>
    <div class="u-teams">${esc(teamName(d, m.a))} <span class="u-vs">vs</span> ${esc(teamName(d, m.b))}</div>
    <button class="u-btn" data-score="${d.id}:${m.id}">${warming ? "Open / start scoring →" : "Score this match →"}</button></div>`;
}
function scoreHtml(t) {
  const live = liveMatches(t);
  let h = `<div class="u-eyebrow" style="margin-bottom:8px">Pick a match to score</div>`;
  if (!live.length) return h + `<div class="u-empty">No live matches. Start a match from the organizer app (or wait for one to go on court), then Refresh.</div>`;
  live.forEach(({ d, m }) => { h += courtCard(t, m.court || 0, d, m); });
  return h;
}

function scorerHtml() {
  const r = resolve();
  if (!r) return `<div class="scorer" style="--sideA:var(--t-c);--sideB:var(--t-b)">
    <div class="mid"><div class="games">…</div><div class="state">Syncing — tap Courts to go back</div></div>
    <div class="bar"><button data-back="1">‹ Courts</button></div></div>`;
  const { t, d, m } = r;
  const tennis = t.format === "tennis";
  const cfg = tennisCfg(t);
  const aName = esc(teamName(d, m.a)), bName = esc(teamName(d, m.b));
  const server = m.tServer || "A";
  let aPt, bPt, mid, state;
  if (tennis) {
    aPt = sidePt(m, "A", cfg); bPt = sidePt(m, "B", cfg);
    mid = `${m.scoreA || 0}–${m.scoreB || 0}${m.tInTb ? " · TB" : ""}`;
    state = stateLine(m, cfg);
  } else {
    const tp = Math.max(2, t.target || 6);
    aPt = String(m.scoreA || 0); bPt = String(m.scoreB || 0);
    mid = `to ${tp}`; state = "";
  }
  const srv = s => tennis && server === s ? `<div class="srv">● Serving</div>` : `<div class="srv"></div>`;
  let h = `<div class="scorer" style="--sideA:var(--t-c);--sideB:var(--t-b)">
    <div class="half a" data-pt="A">
      <div class="tname">${aName}</div>
      <div class="pt">${aPt}</div>${srv("A")}
      <div class="tap">tap to score</div>
    </div>
    <div class="half b" data-pt="B">
      <div class="tap" style="top:14px;bottom:auto">tap to score</div>
      ${srv("B")}<div class="pt">${bPt}</div>
      <div class="tname">${bName}</div>
    </div>
    <div class="mid"><div class="games">${mid}</div><div class="state">${esc(state) || "&nbsp;"}</div></div>
    <div class="bar">
      <button data-back="1">‹ Courts</button>
      <button data-undo="1">↶ Undo</button>
      ${tennis ? `<button data-server="1">Serve: ${server}</button>` : ""}
    </div>`;
  if (wonShown && m.done) {
    const aWon = (m.scoreA || 0) > (m.scoreB || 0);
    h += `<div class="won-ov"><div class="p">
      <div class="t">${aWon ? aName : bName} win${(aWon ? aName : bName).includes("/") ? "" : "s"}</div>
      <div class="s">Final: ${m.scoreA || 0}–${m.scoreB || 0}${tennis ? " games" : ""}</div>
      <div class="row">
        <button class="go" data-submit="1">Submit result</button>
        <button class="ghost" data-undo2="1">Undo point</button>
      </div></div></div>`;
  }
  h += `</div>`;
  return h;
}

/* ---------- scoring actions ---------- */
function addPoint(side) {
  const r = resolve(); if (!r) return;
  const { t, m } = r;
  if (m.done) return;
  // first point begins the match if it was only warming up / not started yet
  if (m.startedAt == null) { m.startedAt = Date.now(); m.warmupStart = null; }
  if (t.format === "tennis") {
    const ev = addTennisPoint(m, side, tennisCfg(t));
    if (ev === "set") wonShown = true;
  } else {
    const tp = Math.max(2, t.target || 6);
    const cur = m["score" + side] || 0;
    if (cur + 1 > tp) return;
    m["score" + side] = cur + 1;
    const a = m.scoreA || 0, b = m.scoreB || 0;
    m.done = (a >= tp || b >= tp) && a !== b;
    if (m.done) wonShown = true;
  }
  commit();
  render();
}
function undo() {
  const r = resolve(); if (!r) return;
  const { t, m } = r;
  if (t.format === "tennis") {
    if (m.done) { // reopen: take the set back to the last game score and clear done
      m.done = false; wonShown = false;
      if (m.tInTb) { m.tbA = Math.max(0, (m.tbA || 0) - 1); }
      else { const win = (m.scoreA || 0) > (m.scoreB || 0) ? "A" : "B"; m["score" + win] = Math.max(0, (m["score" + win] || 0) - 1); }
    } else {
      undoTennisPoint(m, "A", tennisCfg(t)) || undoTennisPoint(m, "B", tennisCfg(t));
    }
  } else {
    const side = (m.scoreA || 0) >= (m.scoreB || 0) ? "A" : "B";
    m["score" + side] = Math.max(0, (m["score" + side] || 0) - 1);
    m.done = false; wonShown = false;
  }
  commit();
  render();
}
function submit() {
  const r = resolve(); if (!r) return;
  const { m } = r;
  if (m.startedAt == null) m.startedAt = Date.now();
  m.endedAt = Date.now(); m.warmupStart = null; m.breakStart = null;
  wonShown = false; scoring = null; view = "courts";
  commit();
  render();
}
function flipServer() { const r = resolve(); if (!r) return; r.m.tServer = (r.m.tServer || "A") === "A" ? "B" : "A"; commit(); render(); }

/* ---------- events ---------- */
function wire() {
  const el = appEl();
  const q = s => el.querySelector(s);
  q("#u-refresh") && q("#u-refresh").addEventListener("click", async () => { const b = q("#u-refresh"); b.textContent = "…"; await doSync(); render(); });
  el.querySelectorAll("[data-v]").forEach(b => b.addEventListener("click", () => { view = b.dataset.v; if (view !== "score") scoring = null; render(); }));
  el.querySelectorAll("[data-score]").forEach(b => b.addEventListener("click", () => { const [did, mid] = b.dataset.score.split(":"); scoring = { did, mid }; wonShown = false; view = "score"; const rr = resolve(); if (rr && rr.m.done) wonShown = true; render(); }));
  el.querySelectorAll("[data-pt]").forEach(h => h.addEventListener("click", () => addPoint(h.dataset.pt)));
  const b1 = q("[data-back]"); if (b1) b1.addEventListener("click", () => { scoring = null; view = "courts"; render(); });
  const u1 = q("[data-undo]"); if (u1) u1.addEventListener("click", e => { e.stopPropagation(); undo(); });
  const sv = q("[data-server]"); if (sv) sv.addEventListener("click", e => { e.stopPropagation(); flipServer(); });
  const sb = q("[data-submit]"); if (sb) sb.addEventListener("click", submit);
  const u2 = q("[data-undo2]"); if (u2) u2.addEventListener("click", undo);
}

/* ---------- boot ---------- */
function startPolling() {
  clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    if (document.hidden || (view === "score" && scoring)) return; // never pull-merge mid-scoring
    const ok = await doSync();
    if (ok) render();
  }, 6000);
}
(async function boot() {
  await load();
  render();
  if (configured()) { await doSync(); tid = tid || (S.tournaments[0] && S.tournaments[0].id) || null; render(); startPolling(); }
  window.addEventListener("online", () => doSync().then(() => render()));
})();
