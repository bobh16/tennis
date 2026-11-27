// Court Sense — Tournaments module.
// Create tournaments (round-robin or single elimination), add divisions
// (category + discipline + letter grade), and enter teams from the roster.
// Matches, standings and scheduling are later phases.
import { TIERS, tierOf } from "./engine.js";
import { tennisCfg, pointLabel, isSuddenDeath } from "./tennis.js";

const CATS = [["womens", "Women's"], ["mens", "Men's"], ["mixed", "Mixed"]];
const DISCS = [["doubles", "Doubles"], ["singles", "Singles"]];
const GRADES = TIERS.map(t => t.cls).slice().reverse(); // A1 (highest) … D2 (lowest)
const FORMATS = [
  { k: "wd", cat: "womens", disc: "doubles", label: "Women's Doubles" },
  { k: "md", cat: "mens", disc: "doubles", label: "Men's Doubles" },
  { k: "xd", cat: "mixed", disc: "doubles", label: "Mixed Doubles" },
  { k: "ws", cat: "womens", disc: "singles", label: "Women's Singles" },
  { k: "ms", cat: "mens", disc: "singles", label: "Men's Singles" },
  { k: "xs", cat: "mixed", disc: "singles", label: "Mixed Singles" },
];

export function createTournaments(ctx) {
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const uid = p => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const players = () => ctx.state.players;
  const tournaments = () => ctx.state.tournaments;
  const findT = id => tournaments().find(t => t.id === id);
  const catLabel = c => (CATS.find(x => x[0] === c) || [])[1] || c;
  const discLabel = d => (DISCS.find(x => x[0] === d) || [])[1] || d;
  const divLabel = d => `${catLabel(d.category)} ${discLabel(d.discipline)} · ${d.grade}`;
  const teamSize = d => d.discipline === "singles" ? 1 : 2;
  const gradeOf = pid => { const p = ctx.byId(pid); return p ? tierOf(p.rating).cls : "—"; };
  const fmtDate = s => { try { return new Date(s + "T12:00:00").toLocaleDateString(undefined, { month: "short", day: "numeric" }); } catch (e) { return s; } };
  const weekdayOf = s => { try { return new Date(s + "T12:00:00").toLocaleDateString(undefined, { weekday: "long" }); } catch (e) { return ""; } };

  /* ---------- scheduling ---------- */
  const DEFAULT_SLOT_MIN = 40; // assumed match length (configurable per tournament)
  const slotMin = t => Math.max(5, (t && t.slotMin) || DEFAULT_SLOT_MIN);
  const slotLenMs = t => slotMin(t) * 60000;
  const warmupMin = t => (t && t.warmupMin != null) ? t.warmupMin : 5;
  const breakMin = t => (t && t.breakMin != null) ? t.breakMin : 2;
  const switchEvery = t => Math.max(1, (t && t.switchEvery) || 3); // switch ends every N points on the running score
  const isTennis = t => t && t.format === "tennis";
  const tGamesOf = t => Math.max(1, (t && t.tGames) || 6); // games to win the set
  const tDeucesOf = t => (t && t.tDeuces != null) ? Math.max(0, t.tDeuces) : 3; // deuces before sudden death
  const targetPts = t => isTennis(t) ? tGamesOf(t) : Math.max(2, (t && t.target) || 6); // games (tennis) or race points
  const isSets = t => t && t.format === "sets";
  const setsOf = t => Math.max(1, (t && t.sets) || 3); // best of N
  const setsToWin = t => Math.ceil(setsOf(t) / 2);
  // Record the finished current set and roll to the next; end the match if decided.
  function awardSet(m, t, side) {
    m.setScores = m.setScores || [];
    m.setScores.push([m.scoreA || 0, m.scoreB || 0]);
    m["sets" + side] = (m["sets" + side] || 0) + 1;
    m.scoreA = 0; m.scoreB = 0; m.tbA = null; m.tbB = null;
    if ((m.setsA || 0) >= setsToWin(t) || (m.setsB || 0) >= setsToWin(t)) {
      m.done = true; // decided — the win modal shows; the umpire taps Finish to end it
      if (!m.startedAt) m.startedAt = Date.now();
    } else { m.done = false; }
  }
  // A match's outcome, mode-aware: who won + total points each (for the quotient).
  function matchOutcome(m, t) {
    if (isSets(t)) {
      const ss = m.setScores || [];
      const gfA = ss.reduce((s, x) => s + x[0], 0), gfB = ss.reduce((s, x) => s + x[1], 0);
      return { aWon: (m.setsA || 0) > (m.setsB || 0), gfA, gfB, done: m.done };
    }
    return { aWon: (m.scoreA || 0) > (m.scoreB || 0), gfA: m.scoreA || 0, gfB: m.scoreB || 0, done: m.done };
  }
  const fmtDur = ms => { const s = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };

  /* ---------- live ticking clock (warm-up / break countdowns, match elapsed) ---------- */
  let ticker = null;
  const fired = new Set(); // countdown keys that have already announced (one beep each)
  function stopTicker() { if (ticker) { clearInterval(ticker); ticker = null; } }
  function beep() {
    try {
      const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return;
      const ac = new AC(); const o = ac.createOscillator(), g = ac.createGain();
      o.connect(g); g.connect(ac.destination); o.type = "sine"; o.frequency.value = 880;
      g.gain.setValueAtTime(0.0001, ac.currentTime);
      g.gain.exponentialRampToValueAtTime(0.35, ac.currentTime + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + 0.6);
      o.start(); o.stop(ac.currentTime + 0.62);
      setTimeout(() => { try { ac.close(); } catch (e) {} }, 900);
    } catch (e) {}
  }
  function tickTimers() {
    const now = Date.now();
    let active = false;
    document.querySelectorAll("[data-elapsed]").forEach(el => { el.textContent = fmtDur(now - (+el.dataset.elapsed)); active = true; });
    document.querySelectorAll("[data-countdown]").forEach(el => {
      const rem = (+el.dataset.countdown) - now;
      if (rem > 0) { el.textContent = fmtDur(rem); active = true; }
      else {
        el.textContent = el.dataset.doneText || "time's up";
        const box = el.closest(".timerbox"); if (box) box.classList.add("timer-done");
        const k = el.dataset.key;
        if (k && !fired.has(k)) { fired.add(k); beep(); }
      }
    });
    if (!active) stopTicker();
  }
  function syncTicker() {
    stopTicker();
    if (detailTab !== "courts") return;
    tickTimers(); // paint immediately
    if (document.querySelector("[data-elapsed]") || [...document.querySelectorAll("[data-countdown]")].some(el => (+el.dataset.countdown) > Date.now()))
      ticker = setInterval(tickTimers, 1000);
  }
  const dayOf = d => d.day || (findT(openId) || {}).startDate || new Date().toISOString().slice(0, 10);
  const fmtClock = ms => { if (ms == null) return ""; try { return new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }); } catch (e) { return ""; } };
  const matchDurMin = m => (m.startedAt != null && m.endedAt != null) ? Math.max(1, Math.round((m.endedAt - m.startedAt) / 60000)) : null;
  function avgDurMin(t) {
    let tot = 0, n = 0;
    t.divisions.forEach(d => d.matches.forEach(m => { const dm = matchDurMin(m); if (dm) { tot += dm; n++; } }));
    return n ? Math.round(tot / n) : DEFAULT_SLOT_MIN;
  }
  function slotMs(m, d) {
    if (!m.slotTime) return null;
    const t = Date.parse(`${dayOf(d)}T${m.slotTime}:00`);
    return isNaN(t) ? null : t;
  }
  // Predict a start time + court for every schedulable match not yet started.
  function predictSchedule(t, d) {
    const avg = slotLenMs(t);
    const courts = Math.max(1, t.courts || 1);
    const now = Date.now();
    const free = new Array(courts).fill(now);
    // in-progress matches hold a court until their predicted end; if a match runs
    // past its slot, the court isn't free until now — so the next game re-estimates
    d.matches.filter(m => m.startedAt != null && m.endedAt == null && m.a && m.b)
      .forEach((m, i) => { if (i < courts) free[i] = Math.max(free[i], m.startedAt + avg, now); });
    const pending = d.matches.filter(m => m.a && m.b && m.startedAt == null && m.endedAt == null)
      .sort((x, y) => (x.round - y.round) || (ordKey(x) - ordKey(y)) || (x.slot - y.slot));
    const pred = new Map();
    pending.forEach(m => {
      let ci = 0; for (let i = 1; i < courts; i++) if (free[i] < free[ci]) ci = i;
      let start = Math.max(free[ci], now);
      const st = slotMs(m, d); if (st != null) start = Math.max(start, st);
      pred.set(m.id, { startMs: start, court: ci + 1 });
      free[ci] = start + avg;
    });
    return pred;
  }
  function nextUpLine(d, pred) {
    const live = d.matches.filter(m => m.startedAt != null && m.endedAt == null && m.a && m.b).length;
    let soonest = null;
    pred.forEach((p, id) => { if (!soonest || p.startMs < soonest.startMs) soonest = { ...p, id }; });
    if (!soonest && !live) return "";
    const parts = [];
    if (live) parts.push(`${live} on court now`);
    if (soonest) {
      const m = d.matches.find(x => x.id === soonest.id);
      const who = m ? `${teamName(d, m.a)} vs ${teamName(d, m.b)}` : "next match";
      parts.push(`next up <b>~${fmtClock(soonest.startMs)}</b> on Court ${soonest.court} — ${who}`);
    }
    return `<p class="tiny muted schednote" style="margin:0 0 8px">${parts.join(" · ")}</p>`;
  }

  /* ---------- tournament-wide day schedule (shared courts, divisions rotate) ---------- */
  const todayISO = () => new Date().toISOString().slice(0, 10);
  const divisionsForDay = (t, day) => t.divisions.filter(d => dayOf(d) === day);
  function daysOf(t) {
    return [...new Set(t.divisions.map(d => dayOf(d)))].sort();
  }
  function dayStartMs(t, day, divs) {
    const calls = divs.map(d => d.callTime).filter(Boolean)
      .map(ct => Date.parse(`${day}T${ct}:00`)).filter(v => !isNaN(v));
    if (calls.length) return Math.min(...calls);
    const def = Date.parse(`${day}T09:00:00`);
    return isNaN(def) ? Date.now() : def;
  }
  // Rotate divisions across the shared court pool: each turn, one division fills
  // the courts with its next matches (no shared team in a block), then rests while
  // the next division plays. Returns timed blocks for the day.
  // The day's divisions in the rotation order the organiser set (rotOrder),
  // falling back to call time then grade.
  function orderedDivsForDay(t, day) {
    const divs = divisionsForDay(t, day).filter(d => d.matches.some(m => m.a && m.b));
    return divs.sort((a, b) => {
      if (a.rotOrder != null || b.rotOrder != null) return (a.rotOrder == null ? 1e9 : a.rotOrder) - (b.rotOrder == null ? 1e9 : b.rotOrder);
      const ca = a.callTime ? Date.parse(`${day}T${a.callTime}:00`) : Infinity;
      const cb = b.callTime ? Date.parse(`${day}T${b.callTime}:00`) : Infinity;
      return (ca - cb) || (GRADES.indexOf(a.grade) - GRADES.indexOf(b.grade));
    });
  }
  function buildDaySchedule(t, day) {
    const courts = Math.max(1, t.courts || 1);
    const alternate = t.alternate !== false; // default on
    const divs = orderedDivsForDay(t, day);
    const queues = divs.map(d => ({ d, ms: [...d.matches].filter(m => m.a && m.b && m.endedAt == null).sort((x, y) => ordKey(x) - ordKey(y)) }));
    const blocks = [];
    // take up to `courts` matches from one division's queue, no team twice in a block
    const fillBlock = q => {
      const block = { div: q.d, slots: [] }, used = new Set();
      while (block.slots.length < courts && q.ms.length) {
        const idx = q.ms.findIndex(m => !used.has(m.a) && !used.has(m.b));
        if (idx < 0) break;
        const m = q.ms.splice(idx, 1)[0];
        used.add(m.a); used.add(m.b);
        block.slots.push({ m, court: block.slots.length + 1 });
      }
      return block.slots.length ? block : null;
    };
    const anyLeft = () => queues.some(q => q.ms.length);
    let guard = 0;
    if (alternate) {
      // one division fills the courts, then yields to the next; cycle round
      let di = 0;
      while (anyLeft() && guard++ < 999) {
        let q = null, scanned = 0;
        while (scanned < queues.length) { const c = queues[di % queues.length]; di++; scanned++; if (c.ms.length) { q = c; break; } }
        if (!q) break;
        const block = fillBlock(q);
        if (block) blocks.push(block);
      }
    } else {
      // each division plays all its matches before the next division starts
      queues.forEach(q => { while (q.ms.length && guard++ < 999) { const block = fillBlock(q); if (!block) break; blocks.push(block); } });
    }
    // lay blocks on the clock: a started block anchors to its real start; otherwise
    // it follows the previous block; a fully-finished block advances by real end.
    const avg = slotLenMs(t);
    const now = Date.now();
    let clock = dayStartMs(t, day, divs);
    blocks.forEach(b => {
      const callMs = b.div.callTime ? Date.parse(`${day}T${b.div.callTime}:00`) : null;
      const floor = (callMs != null && !isNaN(callMs)) ? Math.max(clock, callMs) : clock; // a division never plays before its call time
      const starts = b.slots.map(s => s.m.startedAt).filter(v => v != null);
      b.start = starts.length ? Math.min(...starts) : floor;
      const ends = b.slots.map(s => s.m.endedAt).filter(v => v != null);
      const allEnded = ends.length === b.slots.length;
      const anyStarted = b.slots.some(s => s.m.startedAt != null);
      // a running block that has blown past its slot pushes the next block to "now"
      const predEnd = allEnded ? Math.max(...ends) : (anyStarted ? Math.max(b.start + avg, now) : b.start + avg);
      clock = Math.max(b.start, predEnd);
    });
    return blocks;
  }

  let openId = null, newOpen = false, build = null; // build = { divisionId, slots: [playerId|null,…] }
  let detailTab = "setup"; // setup | schedule | courts | standings
  let finishPrompt = null; // matchId whose "no team has reached the target yet" confirm is open
  let pf = new Set(), pg = new Set(), draft = new Map(); // division batch builder: formats, grades, staged divisions

  const findDiv = id => { const t = findT(openId); return t && t.divisions.find(d => d.id === id); };

  function render() {
    ctx.mount.innerHTML = openId ? detailHtml(findT(openId)) : listHtml();
    wire();
    syncTicker();
  }

  /* ---------- list + create ---------- */
  function listHtml() {
    let h = `<div class="row spread wrap" style="align-items:flex-end">
      <div><div class="eyebrow">Competitions</div><h2 style="font-size:22px">Tournament</h2></div>
      <button class="btn cta sm" id="tNew">+ New tournament</button></div>`;
    if (newOpen) h += newFormHtml();
    const ts = tournaments();
    if (!ts.length && !newOpen) {
      h += `<div class="empty" style="padding:28px"><h2 style="font-size:19px">No tournaments yet</h2>
        <p>Create one to set up divisions, enter teams from your roster, and track standings. You can run several at once.</p></div>`;
    }
    if (ts.length) h += `<div class="stack" style="gap:10px">` + ts.map(cardHtml).join("") + `</div>`;
    return h;
  }
  function newFormHtml() {
    const today = new Date().toISOString().slice(0, 10);
    return `<div class="card pad stack">
      <div class="eyebrow">New tournament</div>
      <label class="field">Name<input type="text" id="tf_name" placeholder="e.g. Tenneast Spring Open" autocomplete="off"></label>
      <div class="row wrap" style="gap:12px">
        <label class="field">Type<select id="tf_type">
          <option value="roundrobin">Round-robin</option><option value="elimination">Single elimination</option></select></label>
        <label class="field">Courts<select id="tf_courts">${[1,2,3,4,5,6,7,8].map(n => `<option ${n === 2 ? "selected" : ""}>${n}</option>`).join("")}</select></label>
      </div>
      <div class="row wrap" style="gap:12px">
        <label class="field">Start date<input type="date" id="tf_start" value="${today}"></label>
        <label class="field">End date<input type="date" id="tf_end" value="${today}"></label>
      </div>
      <div class="row" style="gap:8px;justify-content:flex-end">
        <button class="btn ghost" id="tf_cancel">Cancel</button>
        <button class="btn primary" id="tf_create">Create tournament</button>
      </div>
    </div>`;
  }
  function cardHtml(t) {
    const divs = t.divisions.length;
    const teams = t.divisions.reduce((n, d) => n + d.teams.length, 0);
    const typeLabel = t.type === "elimination" ? "Single elimination" : "Round-robin";
    const dates = t.startDate === t.endDate ? fmtDate(t.startDate) : `${fmtDate(t.startDate)} – ${fmtDate(t.endDate)}`;
    return `<div class="tcard card pad" data-open="${t.id}" role="button" tabindex="0">
      <div class="row spread" style="align-items:flex-start">
        <div><div class="tcard-name">${esc(t.name || "Untitled")}</div>
          <div class="tiny muted">${typeLabel} · ${t.courts} court${t.courts > 1 ? "s" : ""} · ${dates}</div></div>
        <span class="tchip" data-tier="c">${divs} div${divs !== 1 ? "s" : ""}</span>
      </div>
      <div class="tiny muted" style="margin-top:4px">${teams} team${teams !== 1 ? "s" : ""} entered · tap to open</div>
    </div>`;
  }

  /* ---------- detail ---------- */
  function detailHtml(t) {
    if (!t) { openId = null; return listHtml(); }
    const typeLabel = t.type === "elimination" ? "Single elimination" : "Round-robin";
    const dates = t.startDate === t.endDate ? fmtDate(t.startDate) : `${fmtDate(t.startDate)} – ${fmtDate(t.endDate)}`;
    let h = `<button class="btn ghost sm" id="tBack" style="align-self:flex-start">← All tournaments</button>
      <div class="row spread wrap" style="align-items:flex-end">
        <div><div class="eyebrow">${typeLabel} · ${t.courts} court${t.courts > 1 ? "s" : ""} · ${dates}</div>
          <h2 style="font-size:22px">${esc(t.name)}</h2></div>
        <div class="row" style="gap:8px;align-items:center">
          <a class="btn ghost sm" href="umpire.html" target="_blank" style="text-decoration:none" title="Open the umpire scoring view (share this link with umpires)">Umpire view ↗</a>
          <button class="btn ghost sm" id="tDelete" style="color:var(--bad)">Delete</button>
        </div>
      </div>`;
    const live = t.divisions.reduce((n, d) => n + d.matches.filter(m => m.startedAt != null && m.endedAt == null && m.a && m.b).length, 0);
    const TABS = [
      ["setup", "Setup"],
      ["schedule", "Schedule"],
      ["courts", `Playing now${live ? ` <span class="livedot">${live}</span>` : ""}`],
      ["standings", "Standings"],
    ];
    h += `<div class="ttabs" role="tablist">` + TABS.map(([k, label]) =>
      `<button class="ttab ${detailTab === k ? "on" : ""}" data-ttab="${k}" role="tab" aria-selected="${detailTab === k}">${label}</button>`).join("") + `</div>`;
    h += `<div class="ttab-body">`;
    if (detailTab === "setup") h += setupTabHtml(t);
    else if (detailTab === "schedule") h += scheduleSectionHtml(t) || `<p class="tiny faint" style="margin:0">No matches yet. Add teams and generate matches in Setup, then set each division's day and call time.</p>`;
    else if (detailTab === "courts") h += courtsTabHtml(t);
    else if (detailTab === "standings") h += standingsTabHtml(t);
    h += `</div>`;
    return h;
  }
  function tDatesHtml(t) {
    return `<div class="card pad datesbar">
      <div class="row wrap" style="gap:14px;align-items:flex-end">
        <label class="divday-lbl tiny muted" title="First day of the tournament">Start date
          <input type="date" id="tf_estart" value="${t.startDate || ""}"></label>
        <label class="divday-lbl tiny muted" title="Last day — leave same as start for a one-day event">End date
          <input type="date" id="tf_eend" value="${t.endDate || t.startDate || ""}"></label>
        <span class="tiny faint">Each division can play on any day in this range.</span>
      </div>
    </div>`;
  }
  function setupTabHtml(t) {
    let h = tDatesHtml(t) + divisionBuilderHtml(t);
    if (!t.divisions.length) return h + `<p class="tiny faint" style="margin:0">No divisions yet. Add one (e.g. Women's Doubles · C1), then enter teams from your roster.</p>`;
    h += matchSettingsHtml(t);
    const today = todayISO();
    const sorted = [...t.divisions].sort((a, b) => {
      const da = dayOf(a), db = dayOf(b);
      return ((da === today ? 0 : 1) - (db === today ? 0 : 1)) || (da < db ? -1 : da > db ? 1 : 0);
    });
    return h + `<div class="stack" style="gap:12px">` + sorted.map(d => divisionHtml(t, d, d.day && dayOf(d) !== today)).join("") + `</div>`;
  }
  function matchSettingsHtml(t) {
    const alternate = t.alternate !== false;
    return `<div class="card pad stack">
      <div class="eyebrow">Match format &amp; courts</div>
      <div class="row wrap" style="gap:14px;align-items:center">
        <label class="divday-lbl tiny muted" title="How many courts are in use">Courts
          <select class="divday" id="sch_courts">${[1,2,3,4,5,6,7,8].map(n => `<option ${n === t.courts ? "selected" : ""}>${n}</option>`).join("")}</select></label>
        <label class="divday-lbl tiny muted" title="How a match is won">Format
          <select class="divday" id="sch_format">
            <option value="race" ${t.format !== "sets" && t.format !== "tennis" ? "selected" : ""}>Race to points</option>
            <option value="sets" ${isSets(t) ? "selected" : ""}>Sets</option>
            <option value="tennis" ${isTennis(t) ? "selected" : ""}>Tennis (games)</option>
          </select></label>
        ${isTennis(t) ? `<label class="divday-lbl tiny muted" title="Games to win the set (win by 2; tiebreak at games-all)">Games to win
          <input type="number" class="divday" id="sch_tgames" min="1" max="12" value="${tGamesOf(t)}" style="width:56px"></label>
        <label class="divday-lbl tiny muted" title="Deuces played with advantage before the next deuce becomes sudden death (0 = no-ad)">Deuces→sudden
          <input type="number" class="divday" id="sch_tdeuces" min="0" max="10" value="${tDeucesOf(t)}" style="width:56px"></label>`
        : `${isSets(t) ? `<label class="divday-lbl tiny muted" title="Best of N sets (3 = first to 2 sets)">Best of
          <select class="divday" id="sch_sets">${[1,3,5,7].map(n => `<option ${n === setsOf(t) ? "selected" : ""}>${n}</option>`).join("")}</select></label>` : ""}
        <label class="divday-lbl tiny muted" title="Points to win ${isSets(t) ? "a set" : "the match"} (tiebreak at one below)">${isSets(t) ? "Set to" : "Race to"}
          <input type="number" class="divday" id="sch_target" min="2" max="21" value="${targetPts(t)}" style="width:56px"></label>
        <label class="divday-lbl tiny muted" title="Switch ends after every this many points on the running score">Switch/points
          <input type="number" class="divday" id="sch_switch" min="1" max="12" value="${switchEvery(t)}" style="width:56px"></label>`}
        <label class="divday-lbl tiny muted" title="Assumed length of a match, used to estimate times">Match ~mins
          <input type="number" class="divday" id="sch_slot" min="5" max="180" step="5" value="${slotMin(t)}" style="width:66px"></label>
        <label class="divday-lbl tiny muted" title="Warm-up countdown length">Warm-up
          <input type="number" class="divday" id="sch_warm" min="0" max="30" value="${warmupMin(t)}" style="width:56px"></label>
        <label class="divday-lbl tiny muted" title="Break countdown length">Break
          <input type="number" class="divday" id="sch_break" min="0" max="30" value="${breakMin(t)}" style="width:56px"></label>
        <label class="altcheck tiny" title="Rotate divisions so each rests between its matches">
          <input type="checkbox" id="sch_alt" ${alternate ? "checked" : ""}> Alternate divisions on the courts</label>
      </div>
      ${isTennis(t) ? `<p class="tiny muted" style="margin:0">Tennis games are scored point-by-point (15/30/40, deuce, advantage) in the <a href="umpire.html" target="_blank" style="color:var(--court);font-weight:700">Umpire view</a>. The organizer sees the running game score.</p>` : ""}
      <p class="tiny muted" style="margin:0">${alternate
        ? `Divisions take turns on the ${t.courts} court${t.courts > 1 ? "s" : ""}: one fills the courts, then rests while the next plays.`
        : `Each division plays all its matches, then the next division starts. Times run from call times and average match length.`}</p>
    </div>`;
  }
  function scheduleSectionHtml(t) {
    const days = daysOf(t).filter(day => divisionsForDay(t, day).some(d => d.matches.some(m => m.a && m.b)));
    if (!days.length) return "";
    const today = todayISO();
    days.sort((a, b) => ((a === today ? 0 : 1) - (b === today ? 0 : 1)) || (a < b ? -1 : 1));
    const alternate = t.alternate !== false;
    let h = `<div class="card pad stack">
      <div class="eyebrow">Schedule · shared courts</div>
      <p class="tiny muted" style="margin:0">${alternate
        ? `Divisions take turns on the ${t.courts} court${t.courts > 1 ? "s" : ""}. Drag the order below to change who plays first.`
        : `Each division plays all its matches in turn. Times run from call times and average match length.`}</p>`;
    days.forEach(day => {
      const blocks = buildDaySchedule(t, day);
      const isToday = day === today;
      const dayDivs = orderedDivsForDay(t, day);
      h += `<div class="schedday"><div class="row spread" style="align-items:center">
        <div class="schedday-h">${weekdayOf(day)}, ${fmtDate(day)}${isToday ? ` <span class="todaytag">Today</span>` : ""}</div>
        <div class="tiny faint">${blocks.length} round${blocks.length !== 1 ? "s" : ""}</div></div>`;
      if (alternate && dayDivs.length > 1) {
        h += `<div class="rotq"><div class="tiny muted" style="font-weight:700;margin-bottom:4px">Rotation order</div>`;
        dayDivs.forEach((d, i) => {
          h += `<div class="rotq-row">
            <span class="morder">
              <button class="iconbtn" data-rotmove="${day}:${d.id}:up" title="Earlier" ${i === 0 ? "disabled" : ""}>↑</button>
              <span class="onum num">${i + 1}</span>
              <button class="iconbtn" data-rotmove="${day}:${d.id}:down" title="Later" ${i === dayDivs.length - 1 ? "disabled" : ""}>↓</button>
            </span>
            <span class="grow" style="font-weight:600;font-size:13px">${divLabel(d)}</span>
            ${d.callTime ? `<span class="tiny faint">call ${fmtClock(Date.parse(`${day}T${d.callTime}:00`))}</span>` : ""}
          </div>`;
        });
        h += `</div>`;
      }
      if (!blocks.length) h += `<p class="tiny faint" style="margin:4px 0 0">All matches finished.</p>`;
      blocks.forEach((b, i) => {
        h += `<div class="schedblock">
          <div class="blockhd"><span class="blocktime">${fmtClock(b.start)}</span>
            <span class="blockdiv">${divLabel(b.div)}</span>
            <span class="tiny faint">Round ${i + 1}</span></div>
          ${b.slots.map(s => scheduleRow(b.div, s.m, s.court)).join("")}</div>`;
      });
      h += `</div>`;
    });
    return h;
  }
  function scheduleRow(d, m, court) {
    const aName = teamName(d, m.a), bName = teamName(d, m.b);
    const sa = m.scoreA == null ? "" : m.scoreA, sb = m.scoreB == null ? "" : m.scoreB;
    const aw = m.done && m.scoreA > m.scoreB, bw = m.done && m.scoreB > m.scoreA;
    const inp = side => `<input class="msc" type="number" min="0" max="99" inputmode="numeric" data-score="${d.id}:${m.id}:${side}" value="${side === "A" ? sa : sb}">`;
    let ctrl;
    if (m.startedAt == null && m.warmupStart == null) ctrl = `<button class="btn sm" data-startwarm="${d.id}:${m.id}:${court}">Warm-up</button><button class="btn sm mstart" data-startmatch="${d.id}:${m.id}:${court}">Start</button>`;
    else if (m.startedAt == null) ctrl = `<span class="mlive">◷ warming up</span><button class="btn sm primary" data-startmatch="${d.id}:${m.id}:${court}">Start</button>`;
    else if (m.endedAt == null) ctrl = `<span class="mlive">● ${fmtClock(m.startedAt)}</span><button class="btn sm primary mfinish" data-finishmatch="${d.id}:${m.id}">Finish</button>`;
    else ctrl = `<span class="mdone-t">${fmtClock(m.startedAt)}–${fmtClock(m.endedAt)}</span>`;
    return `<div class="mrow ${m.done ? "done" : ""}">
      <span class="courttag">C${court}</span>
      <span class="mt ${aw ? "win" : ""}">${aName}</span>
      ${inp("A")}<span class="faint mono">–</span>${inp("B")}
      <span class="mt end ${bw ? "win" : ""}">${bName}</span>
      ${tbLabel(m)}
      <span class="schedctrl">${ctrl}</span>
    </div>`;
  }
  /* ---------- Playing now (live court board) ---------- */
  function courtsTabHtml(t) {
    const courts = Math.max(1, t.courts || 1);
    // every match, tagged with its division, split into live / finished
    const all = [];
    t.divisions.forEach(d => d.matches.forEach(m => { if (m.a && m.b) all.push({ d, m }); }));
    // active = on court now: warming up or playing. Stays until the umpire
    // finishes it (endedAt), even once the score is decided at 6.
    const activeOnes = all.filter(x => (x.m.startedAt != null || x.m.warmupStart != null) && x.m.endedAt == null);
    const byCourt = {};
    activeOnes.forEach(x => { if (x.m.court) (byCourt[x.m.court] = byCourt[x.m.court] || []).push(x); });
    const unplaced = activeOnes.filter(x => !x.m.court);
    let h = `<div class="courts">`;
    for (let n = 1; n <= courts; n++) {
      const here = (byCourt[n] || [])[0] || unplaced.shift();
      h += courtBoardCard(t, n, here);
    }
    h += `</div>`;
    // recent results — only matches actually finished on a court
    const done = all.filter(x => x.m.endedAt != null)
      .sort((a, b) => (b.m.endedAt || 0) - (a.m.endedAt || 0));
    h += `<div class="stack" style="gap:6px;margin-top:14px"><div class="eyebrow">Recent results</div>`;
    h += done.length ? done.slice(0, 20).map(x => resultRow(x.d, x.m, t)).join("")
      : `<p class="tiny faint" style="margin:0">No finished matches yet.</p>`;
    h += `</div>`;
    return h;
  }
  function courtBoardCard(t, n, x) {
    if (!x) return `<div class="court free">
      <div class="court-hd"><span class="cn">Court ${n}</span><span class="cavg">open</span></div>
      <div class="freebody"><p class="muted" style="margin:0;font-weight:600">No match running</p>
        <p class="tiny faint" style="margin:0">Warm up or start a match from the Schedule to put it here.</p></div></div>`;
    const { d, m } = x;
    const teams = `<div class="team"><div class="teamtag">Team A</div><div class="pl"><span class="nm">${teamName(d, m.a)}</span></div></div>
      <div class="vs">VS</div>
      <div class="team b"><div class="teamtag">Team B</div><div class="pl"><span class="nm">${teamName(d, m.b)}</span></div></div>`;

    // Phase 1 — warming up (not started yet)
    if (m.startedAt == null && m.warmupStart != null) {
      const end = m.warmupStart + warmupMin(t) * 60000;
      return `<div class="court warming divcard" style="--gbar:var(--t-${gradeKey(d)})">
        <div class="court-hd"><span class="cn">Court ${n}</span><span class="cavg">${divLabel(d)}</span></div>
        ${teams}
        <div class="timerbox"><div class="timerlabel">Warm-up left</div>
          <div class="timerval" data-countdown="${end}" data-key="wu:${m.id}" data-done-text="▶ Time to start!">${fmtDur(end - Date.now())}</div></div>
        <div class="court-foot row" style="gap:8px;justify-content:center">
          <button class="btn ghost sm" data-cancelwarm="${d.id}:${m.id}">Cancel</button>
          <button class="btn cta" data-startmatch="${d.id}:${m.id}:${m.court || n}">Start match ▶</button></div>
      </div>`;
    }

    // Phase 2 (tennis) — games are scored point-by-point in the Umpire view; the
    // organizer sees the running game + set score read-only, plus finish controls.
    if (isTennis(t)) return tennisCourtCard(t, n, d, m);

    // Phase 2 — match live
    const tp = targetPts(t);
    const inTiebreak = m.scoreA === tp - 1 && m.scoreB === tp - 1 && !m.done;
    const gameStep = side => `<div class="livescore"><button class="sbtn" data-mscore="${d.id}:${m.id}:${side}:dec">–</button>` +
      `<span class="sval num" data-sval="${side}">${m["score" + side] == null ? 0 : m["score" + side]}</span>` +
      `<button class="sbtn" data-mscore="${d.id}:${m.id}:${side}:inc">+</button></div>`;
    const tbStep = side => `<div class="livescore tb"><button class="sbtn" data-mtb="${d.id}:${m.id}:${side}:dec">–</button>` +
      `<span class="sval num" data-sval="${side}">${m["tb" + side] || 0}</span>` +
      `<button class="sbtn" data-mtb="${d.id}:${m.id}:${side}:inc">+</button></div>`;
    const step = inTiebreak ? tbStep : gameStep;
    // switch ends every N points of the running score (tiebreak points while in a tiebreak)
    const pts = inTiebreak ? ((m.tbA || 0) + (m.tbB || 0)) : ((m.scoreA || 0) + (m.scoreB || 0));
    const switchNow = pts > 0 && pts % switchEvery(t) === 0;
    // break timer (optional, during the match)
    let breakHtml = "";
    if (m.breakStart != null) {
      const bend = m.breakStart + breakMin(t) * 60000;
      breakHtml = `<div class="timerbox break"><div class="timerlabel">Break left</div>
        <div class="timerval" data-countdown="${bend}" data-key="br:${m.id}:${m.breakStart}" data-done-text="▶ Back on!">${fmtDur(bend - Date.now())}</div>
        <button class="btn ghost sm" data-endbreak="${d.id}:${m.id}">End break</button></div>`;
    }
    const sets = isSets(t);
    const setHist = sets && (m.setScores || []).length ? `<div class="sethist">Sets: ${m.setScores.map(s => `${s[0]}–${s[1]}`).join(" · ")}</div>` : "";
    const cap = inTiebreak
      ? `<div class="score-cap tbcap">${tp - 1}–${tp - 1} → Tiebreak · first to 7 wins the ${sets ? "set" : "match"}</div>`
      : `<div class="score-cap">${sets ? `Best of ${setsOf(t)} · set to ${tp}` : `Race to ${tp}`} · tiebreak at ${tp - 1}–${tp - 1} · switch every ${switchEvery(t)} pts</div>`;
    // decided but not yet finished — a modal over the card confirms the result
    let modalHtml = "";
    if (m.done) {
      const aWon = matchOutcome(m, t).aWon;
      const wname = teamName(d, aWon ? m.a : m.b);
      const scoreTxt = sets ? `Sets ${m.setsA || 0}–${m.setsB || 0}` : `${m.scoreA ?? 0}–${m.scoreB ?? 0}`;
      modalHtml = `<div class="wonmodal">
        <div class="wonpanel">
          <div class="woneyebrow">🏆 Match won</div>
          <div class="wontitle">Team ${aWon ? "A" : "B"} won the match</div>
          <div class="wonsub">${wname} · ${scoreTxt}</div>
          <div class="wonbtns">
            <button class="btn cta" data-finishmatch="${d.id}:${m.id}">Finish match</button>
            <button class="btn ghost" data-undopoint="${d.id}:${m.id}">Undo point</button>
          </div>
          <p class="tiny faint" style="margin:0">Undo point reopens the score so you can fix a point given to the wrong team.</p>
        </div></div>`;
    } else if (finishPrompt === m.id) {
      modalHtml = `<div class="wonmodal">
        <div class="wonpanel">
          <div class="woneyebrow" style="color:var(--warn)">Hold on</div>
          <div class="wontitle">${sets ? "The match isn’t decided yet" : `No team has scored ${tp} points yet`}</div>
          <div class="wonsub">${m.scoreA ?? 0}–${m.scoreB ?? 0}</div>
          <div class="wonbtns">
            <button class="btn cta" data-continuematch="${m.id}">Continue match</button>
            <button class="btn ghost" data-removequeue="${d.id}:${m.id}">Remove from queue</button>
          </div>
          <p class="tiny faint" style="margin:0">Remove from queue takes this match off the court and back to the schedule, unplayed.</p>
        </div></div>`;
    }
    return `<div class="court divcard${inTiebreak ? " tiebreak" : ""}${m.done ? " won" : ""}" data-mcard="${m.id}" style="--gbar:var(--t-${gradeKey(d)})">
      ${modalHtml}
      <div class="court-hd"><span class="cn">Court ${n}</span><span class="cavg">${divLabel(d)}</span>
        <span class="matchclock" data-elapsed="${m.startedAt}" title="Time on court">${fmtDur(Date.now() - m.startedAt)}</span>
        ${sets ? `<span class="sets-badge" title="Sets won">Sets ${m.setsA || 0}–${m.setsB || 0}</span>` : ""}
        <span class="games-badge" title="${sets ? "Current set" : "Score"}">${m.scoreA == null ? 0 : m.scoreA}–${m.scoreB == null ? 0 : m.scoreB}</span></div>
      ${setHist}
      <div class="switchnote${switchNow ? "" : " hide"}">↔ Switch sides</div>
      <div class="team"><div class="teamtag">Team A</div><div class="pl"><span class="nm">${teamName(d, m.a)}</span></div></div>
      ${step("A")}
      <div class="vs">VS</div>
      <div class="team b"><div class="teamtag">Team B</div><div class="pl"><span class="nm">${teamName(d, m.b)}</span></div></div>
      ${step("B")}
      ${cap}
      ${breakHtml}
      <div class="court-foot row" style="gap:8px;justify-content:center">
        ${m.breakStart == null ? `<button class="btn ghost sm" data-startbreak="${d.id}:${m.id}">Break</button>` : ""}
        <button class="btn cta finishbtn" data-tryfinish="${d.id}:${m.id}">Match finished ✓</button></div>
    </div>`;
  }
  function tennisCourtCard(t, n, d, m) {
    const cfg = tennisCfg(t);
    const sideDisp = side => {
      if (m.tInTb) return m["tb" + side] || 0;
      const a = m.tpA || 0, b = m.tpB || 0;
      if (a >= 3 && b >= 3 && a !== b) return side === (a > b ? "A" : "B") ? "Ad" : "40";
      return pointLabel(m[side === "A" ? "tpA" : "tpB"] || 0);
    };
    let stateTxt = "";
    const a = m.tpA || 0, b = m.tpB || 0;
    if (m.tInTb) stateTxt = "Tiebreak · first to 7";
    else if (a >= 3 && b >= 3) stateTxt = a === b ? (isSuddenDeath(m, cfg) ? "Sudden death" : "Deuce") : ("Advantage Team " + (a > b ? "A" : "B"));
    let modalHtml = "";
    if (m.done) {
      const aWon = (m.scoreA || 0) > (m.scoreB || 0);
      modalHtml = `<div class="wonmodal"><div class="wonpanel">
        <div class="woneyebrow">🏆 Set won</div>
        <div class="wontitle">Team ${aWon ? "A" : "B"} won the match</div>
        <div class="wonsub">${esc(teamName(d, aWon ? m.a : m.b))} · ${m.scoreA || 0}–${m.scoreB || 0} games</div>
        <div class="wonbtns"><button class="btn cta" data-finishmatch="${d.id}:${m.id}">Finish match</button>
          <button class="btn ghost" data-undopoint="${d.id}:${m.id}">Undo point</button></div></div></div>`;
    } else if (finishPrompt === m.id) {
      modalHtml = `<div class="wonmodal"><div class="wonpanel">
        <div class="woneyebrow" style="color:var(--warn)">Hold on</div>
        <div class="wontitle">The set isn’t finished yet</div>
        <div class="wonsub">${m.scoreA || 0}–${m.scoreB || 0} games</div>
        <div class="wonbtns"><button class="btn cta" data-continuematch="${m.id}">Continue match</button>
          <button class="btn ghost" data-removequeue="${d.id}:${m.id}">Remove from queue</button></div></div></div>`;
    }
    return `<div class="court divcard${m.done ? " won" : ""}" data-mcard="${m.id}" style="--gbar:var(--t-${gradeKey(d)})">
      ${modalHtml}
      <div class="court-hd"><span class="cn">Court ${n}</span><span class="cavg">${divLabel(d)} · Tennis</span>
        <span class="matchclock" data-elapsed="${m.startedAt}" title="Time on court">${fmtDur(Date.now() - m.startedAt)}</span>
        <span class="games-badge" title="Games">${m.scoreA || 0}–${m.scoreB || 0}</span></div>
      <div class="team"><div class="teamtag">Team A</div><div class="pl"><span class="nm">${teamName(d, m.a)}</span></div></div>
      <div class="tpoint num">${sideDisp("A")}</div>
      <div class="vs">${stateTxt || "VS"}</div>
      <div class="team b"><div class="teamtag">Team B</div><div class="pl"><span class="nm">${teamName(d, m.b)}</span></div></div>
      <div class="tpoint num">${sideDisp("B")}</div>
      <div class="score-cap">Set to ${tGamesOf(t)} games · ${tDeucesOf(t) === 0 ? "no-ad" : tDeucesOf(t) + " deuces then sudden death"}</div>
      <a class="btn cta finishbtn" href="umpire.html" target="_blank" style="display:block;text-align:center;text-decoration:none;margin:0 14px 10px">Score point-by-point in Umpire view ↗</a>
      <div class="court-foot row" style="gap:8px;justify-content:center">
        <button class="btn ghost sm" data-startbreak="${d.id}:${m.id}">Break</button>
        <button class="btn cta finishbtn" data-tryfinish="${d.id}:${m.id}">Match finished ✓</button></div>
    </div>`;
  }
  const wasTiebreak = m => m.tbA != null && (m.tbA || m.tbB);
  const tbLabel = m => wasTiebreak(m) ? `<span class="tbtag" title="Decided by a 7-point tiebreak">TB ${m.tbA}–${m.tbB}</span>` : "";
  function resultRow(d, m, tourn) {
    const sets = isSets(tourn);
    const o = matchOutcome(m, tourn);
    const aw = o.done && o.aWon, bw = o.done && !o.aWon;
    const mainA = sets ? (m.setsA || 0) : (m.scoreA == null ? "–" : m.scoreA);
    const mainB = sets ? (m.setsB || 0) : (m.scoreB == null ? "–" : m.scoreB);
    const detail = sets && (m.setScores || []).length
      ? `<span class="tbtag" title="Set scores">${m.setScores.map(s => `${s[0]}-${s[1]}`).join(" ")}</span>`
      : tbLabel(m);
    const time = m.endedAt ? fmtClock(m.endedAt) : "";
    return `<div class="mrow done">
      <span class="courttag">${d.grade}</span>
      <span class="mt ${aw ? "win" : ""}">${teamName(d, m.a)}</span>
      <span class="num"><b>${mainA}</b></span><span class="faint mono">–</span><span class="num"><b>${mainB}</b></span>
      <span class="mt end ${bw ? "win" : ""}">${teamName(d, m.b)}</span>
      ${detail}
      ${time ? `<span class="mdone-t">${time}</span>` : ""}
    </div>`;
  }
  /* ---------- Standings (all divisions) ---------- */
  function standingsTabHtml(t) {
    const rr = t.divisions.filter(d => d.discipline !== undefined);
    const withMatches = t.divisions.filter(d => d.matches.some(m => m.a && m.b));
    if (!withMatches.length) return `<p class="tiny faint" style="margin:0">No matches yet — standings appear once matches are generated and scored.</p>`;
    return withMatches.map(d => `<div class="card pad divcard" style="--gbar:var(--t-${gradeKey(d)})"><div class="divtitle" style="margin-bottom:2px">${divLabel(d)}</div>` +
      (t.type === "elimination" ? bracketStandingNote(d) : standingsHtml(d, t)) + `</div>`).join("");
  }
  function bracketStandingNote(d) {
    const rounds = [...new Set(d.matches.map(m => m.round))];
    const total = rounds.length;
    const finalM = d.matches.find(m => m.round === total);
    const champ = finalM && winnerOf(finalM);
    return champ ? `<p class="tiny" style="margin:6px 0 0;color:var(--good);font-weight:700">🏆 ${teamName(d, champ)} — champion</p>`
      : `<p class="tiny faint" style="margin:6px 0 0">Bracket in progress — see Setup for the draw.</p>`;
  }
  function divisionBuilderHtml(t) {
    const d = [...draft.values()], n = pf.size * pg.size;
    return `<div class="card pad stack">
      <div class="eyebrow">Add divisions</div>
      <div><div class="plbl">Formats</div><div class="chips">${FORMATS.map(f => `<button class="fchip ${pf.has(f.k) ? "on" : ""}" data-pf="${f.k}"><span class="fbox"></span>${f.label}</button>`).join("")}</div></div>
      <div><div class="plbl">Grades</div><div class="chips">${GRADES.slice().reverse().map(g => `<span class="tchip pick ${pg.has(g) ? "sel" : ""}" data-tier="${g[0].toLowerCase()}" data-pg="${g}">${g}</span>`).join("")}</div></div>
      <div class="row wrap" style="gap:8px">
        <button class="btn sm primary" id="pbatch" ${n ? "" : "disabled"}>+ Add ${n ? n + " " : ""}to list</button>
        ${d.length ? `<button class="btn sm ghost" id="pclear">Clear list</button>` : ""}
      </div>
      ${d.length ? `<div><div class="plbl">To create · ${d.length}</div>
        <div class="preview">${d.map(x => `<span class="dchip">${catLabel(x.category)} ${discLabel(x.discipline)} · ${x.grade}<button class="x" data-pdel="${x.key}" aria-label="Remove">×</button></span>`).join("")}</div>
        <button class="btn cta sm" id="pcreate" style="margin-top:10px">Create ${d.length} division${d.length > 1 ? "s" : ""}</button></div>`
        : `<p class="tiny faint" style="margin:0">Pick formats and grades, add them to the list (stack as many batches as you like), then create them all. Duplicates are skipped.</p>`}
    </div>`;
  }
  const gradeKey = d => ((d.grade && d.grade[0]) || "d").toLowerCase();
  function divisionHtml(t, d, offDay) {
    const day = dayOf(d);
    const callTxt = d.callTime ? ` · call ${fmtClock(Date.parse(`${day}T${d.callTime}:00`))}` : "";
    let h = `<div class="card pad divcard${offDay ? " offday" : ""}" data-div="${d.id}" style="--gbar:var(--t-${gradeKey(d)})">
      ${offDay ? `<div class="offday-tag tiny">Not playing today — plays ${weekdayOf(day)}</div>` : ""}
      <div class="row spread" style="align-items:flex-start;gap:8px">
        <div><div class="divtitle">${divLabel(d)}</div>
          <div class="tiny muted">${d.teams.length} ${teamSize(d) === 1 ? "player" : "team"}${d.teams.length !== 1 ? "s" : ""} · ${weekdayOf(day)}${callTxt}</div></div>
        <div class="row" style="gap:6px;align-items:center;flex:none">
          <label class="divday-lbl tiny muted" title="Day this division plays">${weekdayOf(day).slice(0,3)}
            <input type="date" class="divday" data-divday="${d.id}" value="${day}"></label>
          <label class="divday-lbl tiny muted" title="Call time — when everyone in this division should arrive">Call
            <input type="time" class="divday" data-calltime="${d.id}" value="${d.callTime || ""}"></label>
          <button class="qbtn qx" data-deldiv="${d.id}" title="Remove division">×</button>
        </div>
      </div>`;
    if (d.callTime) h += `<p class="tiny callnote" style="margin:6px 0 0">Everyone in ${divLabel(d)} should arrive by <b>${fmtClock(Date.parse(`${day}T${d.callTime}:00`))}</b> — the playing order can change, so all players need to be here.</p>`;
    if (d.teams.length) h += `<div class="stack" style="gap:6px;margin-top:10px">` + d.teams.map((tm, i) => teamRow(d, tm, i, t)).join("") + `</div>`;
    h += teamBuilderHtml(d);
    h += matchesSectionHtml(t, d);
    return h + `</div>`;
  }

  /* ---------- matches, bracket, standings ---------- */
  function teamName(d, teamId) {
    const tm = d.teams.find(x => x.id === teamId);
    if (!tm) return "—";
    return tm.players.map(pid => { const p = ctx.byId(pid); return p ? esc(p.name) : "?"; }).join(" / ");
  }
  const matchPlayed = m => m.endedAt != null || m.done;
  // matches this team has finished, in its division
  function teamPlayed(d, teamId) {
    return d.matches.filter(m => (m.a === teamId || m.b === teamId) && matchPlayed(m)).length;
  }
  // matches this player has finished across every team they're on in this tournament
  function playerPlayed(t, playerId) {
    let n = 0;
    (t.divisions || []).forEach(d => {
      const mine = new Set(d.teams.filter(tm => (tm.players || []).includes(playerId)).map(tm => tm.id));
      if (!mine.size) return;
      d.matches.forEach(m => { if ((mine.has(m.a) || mine.has(m.b)) && matchPlayed(m)) n++; });
    });
    return n;
  }
  function genRoundRobin(teams) {
    const ms = [];
    for (let i = 0; i < teams.length; i++)
      for (let j = i + 1; j < teams.length; j++)
        ms.push({ id: uid("m"), round: 1, slot: ms.length, ord: ms.length, a: teams[i].id, b: teams[j].id, scoreA: null, scoreB: null, done: false, winner: null });
    return balancedOrder(ms); // start spaced out, not in raw A-vs-B order
  }
  const ordKey = (m, i) => (m.ord != null ? m.ord : (m.slot != null ? m.slot : i));
  // Reorder matches so each team rests between its games as much as possible.
  // Greedy: next match is the one whose more-recently-played team rested longest;
  // random tiebreak keeps the draw fresh. Reassigns ord to the new positions.
  function balancedOrder(matches) {
    const remaining = matches.slice(), out = [], lastPos = {};
    while (remaining.length) {
      let best = [], bestScore = -1;
      remaining.forEach(m => {
        const la = lastPos[m.a] == null ? -999 : lastPos[m.a];
        const lb = lastPos[m.b] == null ? -999 : lastPos[m.b];
        const score = Math.min(out.length - la, out.length - lb); // bigger = both rested longer
        if (score > bestScore) { bestScore = score; best = [m]; }
        else if (score === bestScore) best.push(m);
      });
      const pick = best[Math.floor(Math.random() * best.length)];
      out.push(pick);
      if (pick.a) lastPos[pick.a] = out.length - 1;
      if (pick.b) lastPos[pick.b] = out.length - 1;
      remaining.splice(remaining.indexOf(pick), 1);
    }
    out.forEach((m, i) => { m.ord = i; });
    return out;
  }
  function seedOrder(size) {
    let seeds = [1, 2];
    while (seeds.length < size) {
      const sum = seeds.length * 2 + 1, next = [];
      seeds.forEach(s => { next.push(s); next.push(sum - s); });
      seeds = next;
    }
    return seeds;
  }
  function genElimination(teams) {
    const ids = teams.map(t => t.id), n = ids.length;
    if (n < 2) return [];
    let size = 1; while (size < n) size *= 2;
    const order = seedOrder(size).map(pos => pos <= n ? ids[pos - 1] : null);
    const matches = [];
    let slot = 0;
    for (let i = 0; i < size; i += 2)
      matches.push({ id: uid("m"), round: 1, slot: slot++, a: order[i], b: order[i + 1], scoreA: null, scoreB: null, done: false, winner: null });
    let count = size / 2, r = 2;
    while (count > 1) {
      for (let s = 0; s < count / 2; s++)
        matches.push({ id: uid("m"), round: r, slot: s, a: null, b: null, scoreA: null, scoreB: null, done: false, winner: null });
      count /= 2; r++;
    }
    return matches;
  }
  function winnerOf(m) {
    if (!m) return null;
    if (m.a && !m.b) return m.a;
    if (m.b && !m.a) return m.b;
    if (m.done && m.scoreA != null && m.scoreB != null && m.scoreA !== m.scoreB) return m.scoreA > m.scoreB ? m.a : m.b;
    return null;
  }
  function advanceBracket(d) {
    const at = {}; let maxRound = 1;
    d.matches.forEach(m => { at[m.round + "-" + m.slot] = m; if (m.round > maxRound) maxRound = m.round; });
    for (let r = 2; r <= maxRound; r++) {
      d.matches.filter(m => m.round === r).forEach(m => {
        m.a = winnerOf(at[(r - 1) + "-" + (m.slot * 2)]);
        m.b = winnerOf(at[(r - 1) + "-" + (m.slot * 2 + 1)]);
      });
    }
  }
  // Round-robin tiebreakers, in tennis order:
  //   1) wins  2) head-to-head among the tied  3) games (sets) quotient
  //   4) once a tie is reduced to two, back to head-to-head.
  // The resolver is recursive so a group broken apart by quotient is re-judged
  // on head-to-head, exactly as the two-player rule requires.
  function standings(d, t) {
    const table = {};
    d.teams.forEach(tm => table[tm.id] = { team: tm, w: 0, l: 0, gf: 0, ga: 0, played: 0 });
    d.matches.forEach(m => {
      if (!m.done || !table[m.a] || !table[m.b]) return;
      const o = matchOutcome(m, t);
      const A = table[m.a], B = table[m.b];
      A.gf += o.gfA; A.ga += o.gfB; B.gf += o.gfB; B.ga += o.gfA;
      A.played++; B.played++;
      if (o.aWon) { A.w++; B.l++; } else { B.w++; A.l++; }
    });
    Object.values(table).forEach(r => { r.q = r.ga > 0 ? r.gf / r.ga : (r.gf > 0 ? Infinity : 0); });
    const beat = (a, b) => { const m = d.matches.find(x => x.done && ((x.a === a && x.b === b) || (x.a === b && x.b === a))); if (!m) return false; return (matchOutcome(m, t).aWon ? m.a : m.b) === a; };
    const groupBy = (arr, fn) => { const m = new Map(); arr.forEach(x => { const k = fn(x); if (!m.has(k)) m.set(k, []); m.get(k).push(x); }); return m; };
    const qnum = k => (k === "inf" ? Infinity : parseFloat(k));
    function breakTie(ids) {
      if (ids.length <= 1) return ids.slice();
      if (ids.length === 2) {
        const [a, b] = ids;
        if (beat(a, b)) return [a, b];
        if (beat(b, a)) return [b, a];
        return table[a].q >= table[b].q ? [a, b] : [b, a];
      }
      // head-to-head mini-record within the tied group
      const miniW = new Map(ids.map(id => [id, 0]));
      for (const a of ids) for (const b of ids) if (a !== b && beat(a, b)) miniW.set(a, miniW.get(a) + 1);
      const miniTiers = groupBy(ids, id => miniW.get(id));
      if (miniTiers.size > 1) {
        let out = [];
        [...miniTiers.keys()].sort((a, b) => b - a).forEach(v => out = out.concat(breakTie(miniTiers.get(v))));
        return out;
      }
      // circular tie → separate by quotient, then re-judge each subgroup on head-to-head
      const qTiers = groupBy(ids, id => table[id].q === Infinity ? "inf" : table[id].q.toFixed(4));
      if (qTiers.size > 1) {
        let out = [];
        [...qTiers.keys()].sort((x, y) => qnum(y) - qnum(x)).forEach(k => { const sub = qTiers.get(k); out = out.concat(sub.length > 1 ? breakTie(sub) : sub); });
        return out;
      }
      return ids.slice().sort((a, b) => table[b].gf - table[a].gf);
    }
    // rank by wins first, then break each win-tier with the recursive resolver
    const winTiers = groupBy(d.teams.map(t => t.id), id => table[id].w);
    let ordered = [];
    [...winTiers.keys()].sort((a, b) => b - a).forEach(v => ordered = ordered.concat(breakTie(winTiers.get(v))));
    return ordered.map(id => table[id]);
  }
  function roundLabel(r, total) {
    if (r === total) return "Final";
    if (r === total - 1) return "Semifinals";
    if (r === total - 2) return "Quarterfinals";
    return "Round " + r;
  }
  function matchRow(d, m, t, pred, ord) {
    const scorable = m.a && m.b;
    const aName = m.a ? teamName(d, m.a) : (m.b ? "(bye)" : "TBD");
    const bName = m.b ? teamName(d, m.b) : (m.a ? "(bye)" : "TBD");
    const sa = m.scoreA == null ? "" : m.scoreA, sb = m.scoreB == null ? "" : m.scoreB;
    const aw = m.done && m.scoreA > m.scoreB, bw = m.done && m.scoreB > m.scoreA;
    const inp = side => `<input class="msc" type="number" min="0" max="99" inputmode="numeric" data-score="${d.id}:${m.id}:${side}" value="${side === "A" ? sa : sb}">`;
    const orderCtrl = ord ? `<span class="morder">
      <button class="iconbtn oup" data-movematch="${d.id}:${m.id}:up" title="Play earlier" ${ord.pos === 0 ? "disabled" : ""}>↑</button>
      <span class="onum num">${ord.pos + 1}</span>
      <button class="iconbtn odn" data-movematch="${d.id}:${m.id}:down" title="Play later" ${ord.pos === ord.count - 1 ? "disabled" : ""}>↓</button>
    </span>` : "";
    return `<div class="mrow ${m.done ? "done" : ""}">
      ${orderCtrl}
      <span class="mt ${aw ? "win" : ""}">${aName}</span>
      ${scorable ? inp("A") : `<span class="faint mono">–</span>`}
      <span class="faint mono">–</span>
      ${scorable ? inp("B") : `<span class="faint mono">–</span>`}
      <span class="mt end ${bw ? "win" : ""}">${bName}</span>
      ${tbLabel(m)}
    </div>${scorable ? schedLine(d, m, t, pred) : ""}`;
  }
  function schedLine(d, m, t, pred) {
    const courts = Math.max(1, t.courts || 1);
    const courtSel = `<select class="mctrl mcourt" data-court="${d.id}:${m.id}"><option value="">Court —</option>` +
      Array.from({ length: courts }, (_, i) => `<option value="${i + 1}" ${m.court === i + 1 ? "selected" : ""}>Court ${i + 1}</option>`).join("") + `</select>`;
    const timeInp = `<input type="time" class="mctrl mtime" data-slottime="${d.id}:${m.id}" value="${m.slotTime || ""}">`;
    let state;
    if (m.startedAt == null) {
      const p = pred && pred.get(m.id);
      const eta = p ? `<span class="meta-eta">~${fmtClock(p.startMs)}${m.court ? "" : ` · Court ${p.court}`}</span>` : "";
      state = `<button class="btn sm mstart" data-startmatch="${d.id}:${m.id}">Start</button>${eta}`;
    } else if (m.endedAt == null) {
      state = `<span class="mlive">● started ${fmtClock(m.startedAt)}</span>` +
        `<button class="btn sm primary mfinish" data-finishmatch="${d.id}:${m.id}">Finish</button>`;
    } else {
      state = `<span class="mdone-t">${fmtClock(m.startedAt)}–${fmtClock(m.endedAt)} · ${matchDurMin(m)}m</span>` +
        `<button class="iconbtn mreset" data-resettime="${d.id}:${m.id}" title="Clear times">↺</button>`;
    }
    return `<div class="msched">${courtSel}${timeInp}${state}</div>`;
  }
  function standingsHtml(d, t) {
    const rows = standings(d, t);
    let h = `<div class="eyebrow" style="margin-top:14px;margin-bottom:6px">Standings
      <span class="infobtn" title="Wins, then head-to-head among tied teams, then quotient (games won ÷ games lost); once a tie is down to two it's head-to-head again" style="cursor:default">i</span></div>
      <div class="tablewrap"><table class="today"><thead><tr><th>#</th><th>Team</th><th class="r">W–L</th><th class="r">Games</th><th class="r">Quotient</th></tr></thead><tbody>`;
    h += rows.map((r, i) => `<tr><td class="num">${i + 1}</td><td>${teamName(d, r.team.id)}</td>` +
      `<td class="r num">${r.w}–${r.l}</td><td class="r num">${r.gf}–${r.ga}</td>` +
      `<td class="r num">${r.q === Infinity ? "∞" : r.q.toFixed(2)}</td></tr>`).join("");
    h += `</tbody></table></div>`;
    return h;
  }
  function bracketHtml(t, d) {
    const rounds = [...new Set(d.matches.map(m => m.round))].sort((a, b) => a - b);
    const total = rounds.length;
    const pred = predictSchedule(t, d);
    let h = `<div class="eyebrow" style="margin-top:14px;margin-bottom:6px">Bracket</div>`;
    h += nextUpLine(d, pred);
    rounds.forEach(r => {
      h += `<div class="tiny muted" style="margin:8px 0 4px;font-weight:700">${roundLabel(r, total)}</div><div class="stack" style="gap:6px">`;
      h += d.matches.filter(m => m.round === r).sort((a, b) => a.slot - b.slot).map(m => matchRow(d, m, t, pred)).join("");
      h += `</div>`;
    });
    const finalM = d.matches.find(m => m.round === total);
    const champ = finalM && winnerOf(finalM);
    if (champ) h += `<div class="banner" style="margin-top:10px"><span aria-hidden="true">🏆</span><div class="grow"><b>${teamName(d, champ)}</b> — division champion.</div></div>`;
    h += `<button class="btn ghost sm" data-regen="${d.id}" style="margin-top:8px">Regenerate bracket</button>`;
    return h;
  }
  function matchesSectionHtml(t, d) {
    if (d.teams.length < 2) return `<p class="tiny faint" style="margin-top:10px">Add at least 2 ${teamSize(d) === 1 ? "players" : "teams"} to generate ${t.type === "elimination" ? "a bracket" : "matches"}.</p>`;
    if (!d.matches.length) {
      const label = t.type === "elimination" ? "Generate bracket" : `Generate matches (${d.teams.length * (d.teams.length - 1) / 2})`;
      return `<button class="btn primary sm" data-genmatches="${d.id}" style="margin-top:12px">${label}</button>`;
    }
    if (t.type === "elimination") return bracketHtml(t, d);
    const pred = predictSchedule(t, d);
    const ordered = [...d.matches].sort((a, b) => ordKey(a) - ordKey(b));
    let h = `<div class="row spread wrap" style="align-items:center;gap:8px;margin-top:14px;margin-bottom:6px">
      <div class="eyebrow" style="margin:0">Match order</div>
      <button class="btn sm" data-shuffle="${d.id}">⤨ Shuffle (balanced rest)</button></div>`;
    h += `<p class="tiny muted" style="margin:0 0 8px">Order decides who plays first. Shuffle spaces each team's games out so no one plays back-to-back; or set it by hand with the ↑ ↓ arrows.</p>`;
    h += nextUpLine(d, pred);
    h += `<div class="stack" style="gap:6px">`;
    h += ordered.map((m, i) => matchRow(d, m, t, pred, { pos: i, count: ordered.length })).join("");
    h += `</div><button class="btn ghost sm" data-regen="${d.id}" style="margin-top:8px">Regenerate</button>`;
    h += standingsHtml(d, t);
    return h;
  }
  function teamRow(d, tm, i, t) {
    const names = tm.players.map(pid => {
      const p = ctx.byId(pid);
      if (!p) return "?";
      const played = playerPlayed(t, pid);
      return `${esc(p.name)} <span class="gradetag">${gradeOf(pid)}</span><span class="mcount" title="Matches this player has played across all divisions">${played}</span>`;
    }).join(` <span class="faint">/</span> `);
    const tc = teamPlayed(d, tm.id);
    return `<div class="trow"><span class="tnum num">${i + 1}</span><span class="grow">${names}</span>
      <span class="tcount" title="Matches this team has played">${tc} played</span>
      <button class="qbtn qx" data-delteam="${d.id}:${tm.id}" title="Remove ${teamSize(d) === 1 ? "player" : "team"}">×</button></div>`;
  }
  function teamBuilderHtml(d) {
    if (!build || build.divisionId !== d.id) {
      return `<button class="btn sm" data-buildteam="${d.id}" style="margin-top:10px">+ Add ${teamSize(d) === 1 ? "player" : "team"}</button>`;
    }
    const slots = build.slots.map((pid, idx) => {
      if (pid) {
        const p = ctx.byId(pid);
        return `<span class="pslot filled" style="flex:0 1 auto"><span class="pslotname">${esc(p.name)} <span class="gradetag">${gradeOf(pid)}</span></span>` +
          `<button class="pslotx" data-unbuild="${idx}">×</button></span>`;
      }
      return `<span class="pslot empty" style="flex:0 1 auto;min-width:120px;justify-content:center">slot ${idx + 1}</span>`;
    }).join("");
    const full = build.slots.every(Boolean);
    const d2 = d;
    return `<div class="card pad" style="margin-top:10px;background:var(--surface-2)">
      <div class="eyebrow" style="margin-bottom:6px">${teamSize(d2) === 1 ? "New player" : "New team — 2 players"}</div>
      <div class="row wrap" style="gap:8px;margin-bottom:8px">${slots}</div>
      <div class="tb-field">
        <input type="text" id="tb_search" placeholder="Search roster — ${catLabel(d.category)} ${d.grade} highlighted" autocomplete="off">
        <div id="tb_results" class="stack rosterbox" style="gap:5px"></div>
      </div>
      <div class="row" style="gap:8px;justify-content:flex-end;margin-top:8px">
        <button class="btn ghost sm" data-cancelbuild="1">Cancel</button>
        <button class="btn primary sm" data-addteam="${d.id}" ${full ? "" : "disabled"}>Add ${teamSize(d2) === 1 ? "player" : "team"}</button>
      </div>
    </div>`;
  }
  function updateBuildResults() {
    const box = ctx.mount.querySelector("#tb_search");
    const results = ctx.mount.querySelector("#tb_results");
    if (!box || !results || !build) return;
    const d = findDiv(build.divisionId);
    if (!d) return;
    const q = box.value.trim().toLowerCase();
    const used = new Set([...d.teams.flatMap(tm => tm.players), ...build.slots.filter(Boolean)]);
    let list = players().filter(p => !used.has(p.id));
    if (q) list = list.filter(p => p.name.toLowerCase().includes(q));
    const want = d.category === "mixed" ? null : (d.category === "womens" ? "f" : "m");
    const hl = p => tierOf(p.rating).cls === d.grade && (!want || !p.gender || p.gender === want);
    list.sort((a, b) => (hl(b) - hl(a)) || (b.rating - a.rating));
    list = list.slice(0, 30);
    results.innerHTML = list.length ? list.map(p => {
      const g = p.gender ? `<span class="gchip ${p.gender}">${p.gender === "f" ? "W" : "M"}</span>` : "";
      return `<div class="sres ${hl(p) ? "hl" : ""}"><span class="nm">${esc(p.name)}</span>${ctx.tierChip(p.rating)}${g}` +
        `<button class="btn sm primary addbtn" data-pick="${p.id}" aria-label="Add ${esc(p.name)}">+</button></div>`;
    }).join("") : `<p class="tiny faint" style="margin:2px 0">${q ? "No matching players." : "Type a name to find a player."}</p>`;
  }

  /* ---------- actions ---------- */
  function createTournament() {
    const el = ctx.mount;
    const name = el.querySelector("#tf_name").value.trim();
    if (!name) { el.querySelector("#tf_name").focus(); return; }
    const t = {
      id: uid("t"), name,
      type: el.querySelector("#tf_type").value,
      courts: parseInt(el.querySelector("#tf_courts").value, 10) || 2,
      startDate: el.querySelector("#tf_start").value,
      endDate: el.querySelector("#tf_end").value || el.querySelector("#tf_start").value,
      divisions: [], createdAt: Date.now(),
    };
    tournaments().push(t); ctx.save();
    newOpen = false; openId = t.id; render();
  }
  function addBatch() {
    if (!pf.size || !pg.size) return;
    FORMATS.filter(f => pf.has(f.k)).forEach(f => pg.forEach(g => {
      const key = f.cat + "|" + f.disc + "|" + g;
      draft.set(key, { category: f.cat, discipline: f.disc, grade: g, key });
    }));
    render();
  }
  function createDivisions() {
    const t = findT(openId); if (!t) return;
    [...draft.values()].forEach(d => {
      if (!t.divisions.some(x => x.category === d.category && x.discipline === d.discipline && x.grade === d.grade))
        t.divisions.push({ id: uid("d"), category: d.category, discipline: d.discipline, grade: d.grade, teams: [], matches: [] });
    });
    draft.clear(); pf.clear(); pg.clear();
    ctx.save(); render();
  }
  function pickPlayer(pid) {
    if (!build) return;
    const i = build.slots.indexOf(null);
    if (i < 0) return;
    const d = findDiv(build.divisionId), p = ctx.byId(pid);
    if (d && p) {
      const reasons = [];
      const g = tierOf(p.rating).cls;
      if (g !== d.grade) reasons.push(`graded ${g}, not ${d.grade}`);
      const want = d.category === "mixed" ? null : (d.category === "womens" ? "f" : "m");
      if (want && p.gender && p.gender !== want) reasons.push(`listed ${p.gender === "f" ? "Women" : "Men"}, not ${catLabel(d.category)}`);
      if (reasons.length && !confirm(`${p.name} is ${reasons.join(" and ")}. Add to ${divLabel(d)} anyway?`)) return;
    }
    build.slots[i] = pid;
    render();
  }
  function addTeam(divId) {
    const d = findDiv(divId); if (!d || !build) return;
    if (build.slots.some(x => !x)) return;
    d.teams.push({ id: uid("tm"), players: build.slots.slice() });
    build = null; ctx.save(); render();
  }
  function genMatches(divId) {
    const t = findT(openId), d = findDiv(divId); if (!t || !d) return;
    d.matches = t.type === "elimination" ? genElimination(d.teams) : genRoundRobin(d.teams);
    if (t.type === "elimination") advanceBracket(d);
    ctx.save(); render();
  }
  function regen(divId) {
    if (!confirm("Regenerate matches? Any entered scores will be cleared.")) return;
    genMatches(divId);
  }
  function setScore(divId, matchId, side, val) {
    const t = findT(openId), d = findDiv(divId); if (!d) return;
    const m = d.matches.find(x => x.id === matchId); if (!m) return;
    const tp = targetPts(t);
    m["score" + side] = val === "" ? null : Math.max(0, Math.min(99, parseInt(val, 10) || 0));
    // manual single-score entry applies to race mode; sets are scored live on the court
    m.done = !isSets(t) && m.scoreA != null && m.scoreB != null && (m.scoreA >= tp || m.scoreB >= tp) && m.scoreA !== m.scoreB;
    if (t && t.type === "elimination") { m.winner = m.done ? (m.scoreA > m.scoreB ? m.a : m.b) : null; advanceBracket(d); }
    ctx.save(); render();
  }
  function setTarget(n) { const t = findT(openId); if (!t) return; t.target = Math.max(2, Math.min(21, parseInt(n, 10) || 6)); ctx.save(); render(); }
  function setFormat(fmt) { const t = findT(openId); if (!t) return; t.format = (fmt === "sets" || fmt === "tennis") ? fmt : "race"; ctx.save(); render(); }
  function setSets(n) { const t = findT(openId); if (!t) return; t.sets = Math.max(1, Math.min(7, parseInt(n, 10) || 3)); ctx.save(); render(); }
  function setTGames(n) { const t = findT(openId); if (!t) return; t.tGames = Math.max(1, Math.min(12, parseInt(n, 10) || 6)); ctx.save(); render(); }
  function setTDeuces(n) { const t = findT(openId); if (!t) return; const v = parseInt(n, 10); t.tDeuces = isNaN(v) ? 3 : Math.max(0, Math.min(10, v)); ctx.save(); render(); }
  function setDivDay(divId, val) {
    const d = findDiv(divId); if (!d) return;
    d.day = val || null; ctx.save(); render();
  }
  function setStartDate(val) {
    const t = findT(openId); if (!t || !val) return;
    t.startDate = val;
    if (!t.endDate || t.endDate < val) t.endDate = val;
    ctx.save(); render();
  }
  function setEndDate(val) {
    const t = findT(openId); if (!t || !val) return;
    t.endDate = val;
    if (!t.startDate || t.startDate > val) t.startDate = val;
    ctx.save(); render();
  }
  function findMatch(divId, matchId) { const d = findDiv(divId); return d && d.matches.find(x => x.id === matchId); }
  function setCourt(divId, matchId, val) {
    const m = findMatch(divId, matchId); if (!m) return;
    m.court = val === "" ? null : parseInt(val, 10); ctx.save(); render();
  }
  function setSlotTime(divId, matchId, val) {
    const m = findMatch(divId, matchId); if (!m) return;
    m.slotTime = val || null; ctx.save(); render();
  }
  function startStamp(divId, matchId, court) {
    const m = findMatch(divId, matchId); if (!m) return;
    m.startedAt = Date.now(); m.endedAt = null; m.warmupStart = null; m.breakStart = null;
    // a match begins at love — clear any stale within-game tennis point state
    m.tpA = 0; m.tpB = 0; m.tDeuces = 0; m.tInTb = false; m.tbA = 0; m.tbB = 0;
    if (!m.tServer) m.tServer = "A";
    if (court != null && court !== "") m.court = parseInt(court, 10);
    ctx.save(); render();
  }
  function startWarmup(divId, matchId, court) {
    const m = findMatch(divId, matchId); if (!m) return;
    m.warmupStart = Date.now();
    if (court != null && court !== "") m.court = parseInt(court, 10);
    fired.delete("wu:" + matchId);
    ctx.save(); render();
  }
  function cancelWarmup(divId, matchId) {
    const m = findMatch(divId, matchId); if (!m) return;
    m.warmupStart = null; fired.delete("wu:" + matchId); ctx.save(); render();
  }
  function startBreak(divId, matchId) {
    const m = findMatch(divId, matchId); if (!m) return;
    m.breakStart = Date.now(); ctx.save(); render();
  }
  function endBreak(divId, matchId) {
    const m = findMatch(divId, matchId); if (!m) return;
    if (m.breakStart != null) fired.delete("br:" + matchId + ":" + m.breakStart);
    m.breakStart = null; ctx.save(); render();
  }
  function setWarmupMin(n) { const t = findT(openId); if (!t) return; t.warmupMin = Math.max(0, Math.min(30, parseInt(n, 10) || 0)); ctx.save(); render(); }
  function setBreakMin(n) { const t = findT(openId); if (!t) return; t.breakMin = Math.max(0, Math.min(30, parseInt(n, 10) || 0)); ctx.save(); render(); }
  function setSwitchEvery(n) { const t = findT(openId); if (!t) return; t.switchEvery = Math.max(1, Math.min(12, parseInt(n, 10) || 3)); ctx.save(); render(); }
  function stepScore(divId, matchId, side, dir) {
    const t = findT(openId), d = findDiv(divId), m = findMatch(divId, matchId); if (!m) return;
    const tp = targetPts(t);
    const beforeTb = m.scoreA === tp - 1 && m.scoreB === tp - 1 && !m.done, beforeDone = !!m.done;
    // undo the last completed set: decrement at 0–0 pops it back open (sets mode)
    if (dir === "dec" && isSets(t) && (m.scoreA || 0) === 0 && (m.scoreB || 0) === 0 && (m.setScores || []).length) {
      const last = m.setScores.pop();
      const winner = last[0] > last[1] ? "A" : "B";
      m["sets" + winner] = Math.max(0, (m["sets" + winner] || 0) - 1);
      m.scoreA = last[0]; m.scoreB = last[1]; m.done = false; m.endedAt = null;
      ctx.save(); render(); return;
    }
    const cur = m["score" + side] == null ? 0 : m["score" + side];
    let next = Math.max(0, Math.min(99, cur + (dir === "inc" ? 1 : -1)));
    // points stop at tp-1 while the other side is on tp-1 — the tiebreak decides it
    const other = side === "A" ? (m.scoreB || 0) : (m.scoreA || 0);
    if (dir === "inc" && next >= tp && other === tp - 1) next = tp - 1;
    // never let a side go past the target — reaching it wins; the win modal takes over
    if (dir === "inc" && next > tp) return;
    m["score" + side] = next;
    if (isSets(t)) {
      if (next >= tp && next - other >= 1) awardSet(m, t, side); // reached the set target with a lead
    } else {
      // decided when a side reaches the target with a lead (0 counts, so a 6–0 shutout is a win)
      const a = m.scoreA || 0, b = m.scoreB || 0;
      m.done = (a >= tp || b >= tp) && a !== b;
    }
    if (t && t.type === "elimination") { m.winner = m.done ? winnerSide(m, t) : null; advanceBracket(d); }
    ctx.save();
    // patch the score in place for an ordinary point (no flash); full render only when
    // crossing into/out of the tiebreak or a win, where the card's structure changes
    const afterTb = m.scoreA === tp - 1 && m.scoreB === tp - 1 && !m.done, afterDone = !!m.done;
    if (isSets(t) || afterTb !== beforeTb || afterDone !== beforeDone || finishPrompt) render();
    else patchLiveScore(divId, matchId);
  }
  // Update just the score numbers / badge / switch note in a live court card — no re-render.
  function patchLiveScore(divId, matchId) {
    const t = findT(openId), m = findMatch(divId, matchId);
    const card = ctx.mount.querySelector(`[data-mcard="${matchId}"]`);
    if (!m || !card) { render(); return; }
    const tp = targetPts(t);
    const inTb = m.scoreA === tp - 1 && m.scoreB === tp - 1 && !m.done;
    const sa = card.querySelector('[data-sval="A"]'), sb = card.querySelector('[data-sval="B"]');
    if (sa) sa.textContent = inTb ? (m.tbA || 0) : (m.scoreA || 0);
    if (sb) sb.textContent = inTb ? (m.tbB || 0) : (m.scoreB || 0);
    const badge = card.querySelector('.games-badge');
    if (badge) badge.textContent = `${m.scoreA == null ? 0 : m.scoreA}–${m.scoreB == null ? 0 : m.scoreB}`;
    const sn = card.querySelector('.switchnote');
    if (sn) {
      const pts = inTb ? ((m.tbA || 0) + (m.tbB || 0)) : ((m.scoreA || 0) + (m.scoreB || 0));
      sn.classList.toggle('hide', !(pts > 0 && pts % switchEvery(t) === 0));
    }
  }
  const winnerSide = (m, t) => matchOutcome(m, t).aWon ? m.a : m.b;
  // (tp-1)-all tiebreak: straight points to 7, first to 7 takes the match tp–(tp-1).
  function stepTiebreak(divId, matchId, side, dir) {
    const t = findT(openId), d = findDiv(divId), m = findMatch(divId, matchId); if (!m) return;
    const tp = targetPts(t);
    const beforeDone = !!m.done;
    m.tbA = m.tbA || 0; m.tbB = m.tbB || 0;
    m["tb" + side] = Math.max(0, (m["tb" + side] || 0) + (dir === "inc" ? 1 : -1));
    if (m.tbA >= 7 || m.tbB >= 7) {
      const win = m.tbA > m.tbB ? "A" : "B";
      if (win === "A") { m.scoreA = tp; m.scoreB = tp - 1; } else { m.scoreB = tp; m.scoreA = tp - 1; }
      if (isSets(t)) { awardSet(m, t, win); } // the tiebreak took the set
      else {
        m.done = true; // decided — the win modal shows; the umpire taps Finish to end it
        if (!m.startedAt) m.startedAt = Date.now();
      }
    } else {
      // corrected back below 7 — reopen the set at (tp-1)-all
      if (m.scoreA >= tp || m.scoreB >= tp) { m.scoreA = tp - 1; m.scoreB = tp - 1; if (!isSets(t)) m.endedAt = null; }
      if (!isSets(t)) m.done = false;
    }
    if (t && t.type === "elimination") { m.winner = m.done ? winnerSide(m, t) : null; advanceBracket(d); }
    ctx.save();
    if (isSets(t) || !!m.done !== beforeDone || finishPrompt) render();
    else patchLiveScore(divId, matchId);
  }
  function finishStamp(divId, matchId) {
    const m = findMatch(divId, matchId); if (!m) return;
    if (m.startedAt == null) m.startedAt = Date.now();
    m.endedAt = Date.now(); m.warmupStart = null; m.breakStart = null; finishPrompt = null; ctx.save(); render();
  }
  // Footer "Match finished" — only finishes once a team has reached the target;
  // otherwise it opens an in-card confirm (continue, or take the match off the court).
  function tryFinish(divId, matchId) {
    const m = findMatch(divId, matchId); if (!m) return;
    if (m.done) { finishStamp(divId, matchId); return; }
    finishPrompt = matchId; render();
  }
  function continueMatch() { finishPrompt = null; render(); }
  function removeFromQueue(divId, matchId) {
    const m = findMatch(divId, matchId); if (!m) return;
    m.startedAt = null; m.endedAt = null; m.warmupStart = null; m.breakStart = null;
    finishPrompt = null; ctx.save(); render();
  }
  // Take back the deciding point so the umpire can correct the score, then reopen the match.
  function undoPoint(divId, matchId) {
    const t = findT(openId), d = findDiv(divId), m = findMatch(divId, matchId); if (!m) return;
    const tp = targetPts(t);
    if (isTennis(t)) {
      // reopen the set by taking back the last game from the winner
      const win = (m.scoreA || 0) > (m.scoreB || 0) ? "A" : "B";
      m["score" + win] = Math.max(0, (m["score" + win] || 0) - 1);
      m.done = false; m.endedAt = null; m.winner = null; m.tInTb = false;
      ctx.save(); render(); return;
    }
    if (isSets(t)) {
      // the match-winning set was just awarded — pop it back open
      if ((m.setScores || []).length) {
        const last = m.setScores.pop();
        const winner = last[0] > last[1] ? "A" : "B";
        m["sets" + winner] = Math.max(0, (m["sets" + winner] || 0) - 1);
        m.scoreA = last[0]; m.scoreB = last[1];
        // if that set ended on a tiebreak, drop the winner back to 6 so it's editable
        if ((m.tbA || 0) >= 7 || (m.tbB || 0) >= 7) { m.tbA = Math.min(m.tbA || 0, 6); m.tbB = Math.min(m.tbB || 0, 6); m.scoreA = tp - 1; m.scoreB = tp - 1; }
      }
    } else if ((m.tbA || 0) >= 7 || (m.tbB || 0) >= 7) {
      // tiebreak-decided match: take back the 7th tiebreak point, back to (tp-1)-all
      const win = (m.tbA || 0) > (m.tbB || 0) ? "A" : "B";
      m["tb" + win] = 6; m.scoreA = tp - 1; m.scoreB = tp - 1;
    } else {
      // normal race win: decrement whichever side reached the target
      const win = (m.scoreA || 0) >= tp ? "A" : "B";
      m["score" + win] = Math.max(0, (m["score" + win] || 0) - 1);
    }
    m.done = false; m.endedAt = null; m.winner = null;
    if (t && t.type === "elimination") advanceBracket(d);
    ctx.save(); render();
  }
  function resetStamp(divId, matchId) {
    const m = findMatch(divId, matchId); if (!m) return;
    m.startedAt = null; m.endedAt = null; ctx.save(); render();
  }
  function setCallTime(divId, val) {
    const d = findDiv(divId); if (!d) return;
    d.callTime = val || null; ctx.save(); render();
  }
  function setCourts(n) {
    const t = findT(openId); if (!t) return;
    t.courts = Math.max(1, Math.min(8, parseInt(n, 10) || 1)); ctx.save(); render();
  }
  function setAlternate(on) {
    const t = findT(openId); if (!t) return;
    t.alternate = !!on; ctx.save(); render();
  }
  function setSlot(n) {
    const t = findT(openId); if (!t) return;
    t.slotMin = Math.max(5, Math.min(180, parseInt(n, 10) || DEFAULT_SLOT_MIN)); ctx.save(); render();
  }
  function moveRotation(day, divId, dir) {
    const t = findT(openId); if (!t) return;
    const ordered = orderedDivsForDay(t, day);
    ordered.forEach((d, i) => { d.rotOrder = i; }); // normalise to current order
    const i = ordered.findIndex(d => d.id === divId);
    const j = dir === "up" ? i - 1 : i + 1;
    if (i < 0 || j < 0 || j >= ordered.length) return;
    const tmp = ordered[i].rotOrder; ordered[i].rotOrder = ordered[j].rotOrder; ordered[j].rotOrder = tmp;
    ctx.save(); render();
  }
  function shuffleOrder(divId) {
    const d = findDiv(divId); if (!d) return;
    balancedOrder([...d.matches].sort((a, b) => ordKey(a) - ordKey(b)));
    ctx.save(); render();
  }
  function moveMatch(divId, matchId, dir) {
    const d = findDiv(divId); if (!d) return;
    const ordered = [...d.matches].sort((a, b) => ordKey(a) - ordKey(b));
    const i = ordered.findIndex(m => m.id === matchId);
    const j = dir === "up" ? i - 1 : i + 1;
    if (i < 0 || j < 0 || j >= ordered.length) return;
    const tmp = ordered[i].ord; ordered[i].ord = ordered[j].ord; ordered[j].ord = tmp;
    ctx.save(); render();
  }

  /* ---------- wiring ---------- */
  function wire() {
    const el = ctx.mount, q = s => el.querySelector(s);
    q("#tNew") && q("#tNew").addEventListener("click", () => { newOpen = true; render(); });
    q("#tf_cancel") && q("#tf_cancel").addEventListener("click", () => { newOpen = false; render(); });
    q("#tf_create") && q("#tf_create").addEventListener("click", createTournament);
    el.querySelectorAll("[data-open]").forEach(c => c.addEventListener("click", () => { openId = c.dataset.open; newOpen = false; build = null; detailTab = "setup"; pf.clear(); pg.clear(); draft.clear(); render(); }));
    q("#tBack") && q("#tBack").addEventListener("click", () => { openId = null; build = null; pf.clear(); pg.clear(); draft.clear(); render(); });
    q("#tDelete") && q("#tDelete").addEventListener("click", () => {
      if (confirm("Delete this tournament? This can't be undone.")) {
        ctx.state.deletedTournaments = [...(ctx.state.deletedTournaments || []), openId]; // tombstone so sync removes it from the cloud too
        ctx.state.tournaments = tournaments().filter(t => t.id !== openId);
        openId = null; build = null; ctx.save(); render();
      }
    });
    el.querySelectorAll("[data-pf]").forEach(b => b.addEventListener("click", () => { const k = b.dataset.pf; pf.has(k) ? pf.delete(k) : pf.add(k); render(); }));
    el.querySelectorAll("[data-pg]").forEach(b => b.addEventListener("click", () => { const g = b.dataset.pg; pg.has(g) ? pg.delete(g) : pg.add(g); render(); }));
    q("#pbatch") && q("#pbatch").addEventListener("click", addBatch);
    q("#pclear") && q("#pclear").addEventListener("click", () => { draft.clear(); render(); });
    el.querySelectorAll("[data-pdel]").forEach(b => b.addEventListener("click", () => { draft.delete(b.dataset.pdel); render(); }));
    q("#pcreate") && q("#pcreate").addEventListener("click", createDivisions);
    el.querySelectorAll("[data-deldiv]").forEach(b => b.addEventListener("click", () => { const t = findT(openId); if (t) { t.divisions = t.divisions.filter(d => d.id !== b.dataset.deldiv); ctx.save(); render(); } }));
    el.querySelectorAll("[data-delteam]").forEach(b => b.addEventListener("click", () => { const [did, tid] = b.dataset.delteam.split(":"); const d = findDiv(did); if (d) { d.teams = d.teams.filter(tm => tm.id !== tid); ctx.save(); render(); } }));
    el.querySelectorAll("[data-buildteam]").forEach(b => b.addEventListener("click", () => { const d = findDiv(b.dataset.buildteam); if (d) { build = { divisionId: d.id, slots: new Array(teamSize(d)).fill(null), justOpened: true }; render(); } }));
    el.querySelectorAll("[data-cancelbuild]").forEach(b => b.addEventListener("click", () => { build = null; render(); }));
    el.querySelectorAll("[data-unbuild]").forEach(b => b.addEventListener("click", () => { if (build) { build.slots[+b.dataset.unbuild] = null; render(); } }));
    el.querySelectorAll("[data-addteam]").forEach(b => b.addEventListener("click", () => addTeam(b.dataset.addteam)));
    el.querySelectorAll("[data-genmatches]").forEach(b => b.addEventListener("click", () => genMatches(b.dataset.genmatches)));
    el.querySelectorAll("[data-regen]").forEach(b => b.addEventListener("click", () => regen(b.dataset.regen)));
    el.querySelectorAll("[data-score]").forEach(inp => inp.addEventListener("change", () => { const [did, mid, side] = inp.dataset.score.split(":"); setScore(did, mid, side, inp.value); }));
    el.querySelectorAll("[data-divday]").forEach(inp => inp.addEventListener("change", () => setDivDay(inp.dataset.divday, inp.value)));
    { const es = q("#tf_estart"); if (es) es.addEventListener("change", () => setStartDate(es.value)); }
    { const ee = q("#tf_eend"); if (ee) ee.addEventListener("change", () => setEndDate(ee.value)); }
    el.querySelectorAll("[data-court]").forEach(sel => sel.addEventListener("change", () => { const [did, mid] = sel.dataset.court.split(":"); setCourt(did, mid, sel.value); }));
    el.querySelectorAll("[data-slottime]").forEach(inp => inp.addEventListener("change", () => { const [did, mid] = inp.dataset.slottime.split(":"); setSlotTime(did, mid, inp.value); }));
    el.querySelectorAll("[data-ttab]").forEach(b => b.addEventListener("click", () => { detailTab = b.dataset.ttab; render(); }));
    const sc = q("#sch_courts"); if (sc) sc.addEventListener("change", () => setCourts(sc.value));
    const sa = q("#sch_alt"); if (sa) sa.addEventListener("change", () => setAlternate(sa.checked));
    const ss = q("#sch_slot"); if (ss) ss.addEventListener("change", () => setSlot(ss.value));
    const stg = q("#sch_target"); if (stg) stg.addEventListener("change", () => setTarget(stg.value));
    const sfmt = q("#sch_format"); if (sfmt) sfmt.addEventListener("change", () => setFormat(sfmt.value));
    const snum = q("#sch_sets"); if (snum) snum.addEventListener("change", () => setSets(snum.value));
    const stg2 = q("#sch_tgames"); if (stg2) stg2.addEventListener("change", () => setTGames(stg2.value));
    const std = q("#sch_tdeuces"); if (std) std.addEventListener("change", () => setTDeuces(std.value));
    const sw = q("#sch_warm"); if (sw) sw.addEventListener("change", () => setWarmupMin(sw.value));
    const sb2 = q("#sch_break"); if (sb2) sb2.addEventListener("change", () => setBreakMin(sb2.value));
    const sv = q("#sch_switch"); if (sv) sv.addEventListener("change", () => setSwitchEvery(sv.value));
    el.querySelectorAll("[data-startwarm]").forEach(b => b.addEventListener("click", () => { const [did, mid, court] = b.dataset.startwarm.split(":"); startWarmup(did, mid, court); }));
    el.querySelectorAll("[data-cancelwarm]").forEach(b => b.addEventListener("click", () => { const [did, mid] = b.dataset.cancelwarm.split(":"); cancelWarmup(did, mid); }));
    el.querySelectorAll("[data-startbreak]").forEach(b => b.addEventListener("click", () => { const [did, mid] = b.dataset.startbreak.split(":"); startBreak(did, mid); }));
    el.querySelectorAll("[data-endbreak]").forEach(b => b.addEventListener("click", () => { const [did, mid] = b.dataset.endbreak.split(":"); endBreak(did, mid); }));
    el.querySelectorAll("[data-rotmove]").forEach(b => b.addEventListener("click", () => { const [day, did, dir] = b.dataset.rotmove.split(":"); moveRotation(day, did, dir); }));
    el.querySelectorAll("[data-startmatch]").forEach(b => b.addEventListener("click", () => { const [did, mid, court] = b.dataset.startmatch.split(":"); startStamp(did, mid, court); }));
    el.querySelectorAll("[data-mscore]").forEach(b => b.addEventListener("click", () => { const [did, mid, side, dir] = b.dataset.mscore.split(":"); stepScore(did, mid, side, dir); }));
    el.querySelectorAll("[data-mtb]").forEach(b => b.addEventListener("click", () => { const [did, mid, side, dir] = b.dataset.mtb.split(":"); stepTiebreak(did, mid, side, dir); }));
    el.querySelectorAll("[data-finishmatch]").forEach(b => b.addEventListener("click", () => { const [did, mid] = b.dataset.finishmatch.split(":"); finishStamp(did, mid); }));
    el.querySelectorAll("[data-tryfinish]").forEach(b => b.addEventListener("click", () => { const [did, mid] = b.dataset.tryfinish.split(":"); tryFinish(did, mid); }));
    el.querySelectorAll("[data-continuematch]").forEach(b => b.addEventListener("click", () => continueMatch()));
    el.querySelectorAll("[data-removequeue]").forEach(b => b.addEventListener("click", () => { const [did, mid] = b.dataset.removequeue.split(":"); removeFromQueue(did, mid); }));
    el.querySelectorAll("[data-undopoint]").forEach(b => b.addEventListener("click", () => { const [did, mid] = b.dataset.undopoint.split(":"); undoPoint(did, mid); }));
    el.querySelectorAll("[data-resettime]").forEach(b => b.addEventListener("click", () => { const [did, mid] = b.dataset.resettime.split(":"); resetStamp(did, mid); }));
    el.querySelectorAll("[data-calltime]").forEach(inp => inp.addEventListener("change", () => setCallTime(inp.dataset.calltime, inp.value)));
    el.querySelectorAll("[data-shuffle]").forEach(b => b.addEventListener("click", () => shuffleOrder(b.dataset.shuffle)));
    el.querySelectorAll("[data-movematch]").forEach(b => b.addEventListener("click", () => { const [did, mid, dir] = b.dataset.movematch.split(":"); moveMatch(did, mid, dir); }));
    const sb = q("#tb_search");
    if (sb) {
      sb.addEventListener("input", updateBuildResults);
      const results = q("#tb_results");
      // results are (re)built by updateBuildResults after this wiring, so delegate the picks
      if (results) results.addEventListener("click", e => { const b = e.target.closest("[data-pick]"); if (b) pickPlayer(b.dataset.pick); });
      updateBuildResults();
      if (build && build.justOpened) { sb.focus(); build.justOpened = false; }
    }
  }

  return { render };
}
