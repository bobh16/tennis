// Court Sense — Tournaments module.
// Create tournaments (round-robin or single elimination), add divisions
// (category + discipline + letter grade), and enter teams from the roster.
// Matches, standings and scheduling are later phases.
import { TIERS, tierOf } from "./engine.js";

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
  const DEFAULT_SLOT_MIN = 20; // fallback match length before any finish-times exist
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
    const avg = avgDurMin(t) * 60000;
    const courts = Math.max(1, t.courts || 1);
    const now = Date.now();
    const free = new Array(courts).fill(now);
    // in-progress matches hold a court until their predicted end
    d.matches.filter(m => m.startedAt != null && m.endedAt == null && m.a && m.b)
      .forEach((m, i) => { if (i < courts) free[i] = Math.max(free[i], m.startedAt + avg); });
    const pending = d.matches.filter(m => m.a && m.b && m.startedAt == null && m.endedAt == null)
      .sort((x, y) => ((slotMs(x, d) || 0) - (slotMs(y, d) || 0)) || (x.round - y.round) || (x.slot - y.slot));
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

  let openId = null, newOpen = false, build = null; // build = { divisionId, slots: [playerId|null,…] }
  let pf = new Set(), pg = new Set(), draft = new Map(); // division batch builder: formats, grades, staged divisions

  const findDiv = id => { const t = findT(openId); return t && t.divisions.find(d => d.id === id); };

  function render() {
    ctx.mount.innerHTML = openId ? detailHtml(findT(openId)) : listHtml();
    wire();
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
        <button class="btn ghost sm" id="tDelete" style="color:var(--bad)">Delete</button>
      </div>`;
    h += divisionBuilderHtml(t);
    if (!t.divisions.length) h += `<p class="tiny faint" style="margin:0">No divisions yet. Add one (e.g. Women's Doubles · C1), then enter teams from your roster.</p>`;
    h += `<div class="stack" style="gap:12px">` + t.divisions.map(d => divisionHtml(t, d)).join("") + `</div>`;
    return h;
  }
  function divisionBuilderHtml(t) {
    const d = [...draft.values()], n = pf.size * pg.size;
    return `<div class="card pad stack">
      <div class="eyebrow">Add divisions</div>
      <div><div class="plbl">Formats</div><div class="chips">${FORMATS.map(f => `<button class="fchip ${pf.has(f.k) ? "on" : ""}" data-pf="${f.k}"><span class="fbox"></span>${f.label}</button>`).join("")}</div></div>
      <div><div class="plbl">Grades</div><div class="chips">${GRADES.map(g => `<span class="tchip pick ${pg.has(g) ? "sel" : ""}" data-tier="${g[0].toLowerCase()}" data-pg="${g}">${g}</span>`).join("")}</div></div>
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
  function divisionHtml(t, d) {
    const day = dayOf(d);
    let h = `<div class="card pad" data-div="${d.id}">
      <div class="row spread" style="align-items:flex-start;gap:8px">
        <div><div class="divtitle">${divLabel(d)}</div>
          <div class="tiny muted">${d.teams.length} ${teamSize(d) === 1 ? "player" : "team"}${d.teams.length !== 1 ? "s" : ""} · ${weekdayOf(day)}</div></div>
        <div class="row" style="gap:6px;align-items:center;flex:none">
          <label class="divday-lbl tiny muted" title="Day this division plays">${weekdayOf(day).slice(0,3)}
            <input type="date" class="divday" data-divday="${d.id}" value="${day}" min="${t.startDate}" max="${t.endDate}"></label>
          <button class="qbtn qx" data-deldiv="${d.id}" title="Remove division">×</button>
        </div>
      </div>`;
    if (d.teams.length) h += `<div class="stack" style="gap:6px;margin-top:10px">` + d.teams.map((tm, i) => teamRow(d, tm, i)).join("") + `</div>`;
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
  function genRoundRobin(teams) {
    const ms = [];
    for (let i = 0; i < teams.length; i++)
      for (let j = i + 1; j < teams.length; j++)
        ms.push({ id: uid("m"), round: 1, slot: ms.length, a: teams[i].id, b: teams[j].id, scoreA: null, scoreB: null, done: false, winner: null });
    return ms;
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
  function standings(d) {
    const table = {};
    d.teams.forEach(tm => table[tm.id] = { team: tm, w: 0, l: 0, gf: 0, ga: 0, played: 0 });
    d.matches.forEach(m => {
      if (!m.done || !table[m.a] || !table[m.b]) return;
      const A = table[m.a], B = table[m.b];
      A.gf += m.scoreA; A.ga += m.scoreB; B.gf += m.scoreB; B.ga += m.scoreA;
      A.played++; B.played++;
      if (m.scoreA > m.scoreB) { A.w++; B.l++; } else { B.w++; A.l++; }
    });
    const rows = Object.values(table).map(r => ({ ...r, q: r.ga > 0 ? r.gf / r.ga : (r.gf > 0 ? Infinity : 0) }));
    rows.sort((x, y) => (y.w - x.w) || (y.q - x.q) || (y.gf - x.gf));
    return rows;
  }
  function roundLabel(r, total) {
    if (r === total) return "Final";
    if (r === total - 1) return "Semifinals";
    if (r === total - 2) return "Quarterfinals";
    return "Round " + r;
  }
  function matchRow(d, m, t, pred) {
    const scorable = m.a && m.b;
    const aName = m.a ? teamName(d, m.a) : (m.b ? "(bye)" : "TBD");
    const bName = m.b ? teamName(d, m.b) : (m.a ? "(bye)" : "TBD");
    const sa = m.scoreA == null ? "" : m.scoreA, sb = m.scoreB == null ? "" : m.scoreB;
    const aw = m.done && m.scoreA > m.scoreB, bw = m.done && m.scoreB > m.scoreA;
    const inp = side => `<input class="msc" type="number" min="0" max="99" inputmode="numeric" data-score="${d.id}:${m.id}:${side}" value="${side === "A" ? sa : sb}">`;
    return `<div class="mrow ${m.done ? "done" : ""}">
      <span class="mt ${aw ? "win" : ""}">${aName}</span>
      ${scorable ? inp("A") : `<span class="faint mono">–</span>`}
      <span class="faint mono">–</span>
      ${scorable ? inp("B") : `<span class="faint mono">–</span>`}
      <span class="mt end ${bw ? "win" : ""}">${bName}</span>
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
  function standingsHtml(d) {
    const rows = standings(d);
    let h = `<div class="eyebrow" style="margin-top:14px;margin-bottom:6px">Standings
      <span class="infobtn" title="Ranked by wins, then quotient (games won ÷ games lost)" style="cursor:default">i</span></div>
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
    let h = `<div class="eyebrow" style="margin-top:14px;margin-bottom:6px">Matches</div>`;
    h += nextUpLine(d, pred);
    h += `<div class="stack" style="gap:6px">`;
    h += d.matches.map(m => matchRow(d, m, t, pred)).join("");
    h += `</div><button class="btn ghost sm" data-regen="${d.id}" style="margin-top:8px">Regenerate</button>`;
    h += standingsHtml(d);
    return h;
  }
  function teamRow(d, tm, i) {
    const names = tm.players.map(pid => {
      const p = ctx.byId(pid);
      return p ? `${esc(p.name)} <span class="gradetag">${gradeOf(pid)}</span>` : "?";
    }).join(` <span class="faint">/</span> `);
    return `<div class="trow"><span class="tnum num">${i + 1}</span><span class="grow">${names}</span>
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
      <input type="text" id="tb_search" placeholder="Search roster — ${catLabel(d.category)} ${d.grade} highlighted" autocomplete="off">
      <div id="tb_results" class="stack rosterbox" style="gap:5px;margin-top:6px"></div>
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
    m["score" + side] = val === "" ? null : Math.max(0, Math.min(99, parseInt(val, 10) || 0));
    m.done = m.scoreA != null && m.scoreB != null && m.scoreA !== m.scoreB;
    if (t && t.type === "elimination") { m.winner = m.done ? (m.scoreA > m.scoreB ? m.a : m.b) : null; advanceBracket(d); }
    ctx.save(); render();
  }
  function setDivDay(divId, val) {
    const d = findDiv(divId); if (!d) return;
    d.day = val || null; ctx.save(); render();
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
  function startStamp(divId, matchId) {
    const m = findMatch(divId, matchId); if (!m) return;
    m.startedAt = Date.now(); m.endedAt = null; ctx.save(); render();
  }
  function finishStamp(divId, matchId) {
    const m = findMatch(divId, matchId); if (!m) return;
    if (m.startedAt == null) m.startedAt = Date.now();
    m.endedAt = Date.now(); ctx.save(); render();
  }
  function resetStamp(divId, matchId) {
    const m = findMatch(divId, matchId); if (!m) return;
    m.startedAt = null; m.endedAt = null; ctx.save(); render();
  }

  /* ---------- wiring ---------- */
  function wire() {
    const el = ctx.mount, q = s => el.querySelector(s);
    q("#tNew") && q("#tNew").addEventListener("click", () => { newOpen = true; render(); });
    q("#tf_cancel") && q("#tf_cancel").addEventListener("click", () => { newOpen = false; render(); });
    q("#tf_create") && q("#tf_create").addEventListener("click", createTournament);
    el.querySelectorAll("[data-open]").forEach(c => c.addEventListener("click", () => { openId = c.dataset.open; newOpen = false; build = null; pf.clear(); pg.clear(); draft.clear(); render(); }));
    q("#tBack") && q("#tBack").addEventListener("click", () => { openId = null; build = null; pf.clear(); pg.clear(); draft.clear(); render(); });
    q("#tDelete") && q("#tDelete").addEventListener("click", () => {
      if (confirm("Delete this tournament? This can't be undone.")) { ctx.state.tournaments = tournaments().filter(t => t.id !== openId); openId = null; build = null; ctx.save(); render(); }
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
    el.querySelectorAll("[data-court]").forEach(sel => sel.addEventListener("change", () => { const [did, mid] = sel.dataset.court.split(":"); setCourt(did, mid, sel.value); }));
    el.querySelectorAll("[data-slottime]").forEach(inp => inp.addEventListener("change", () => { const [did, mid] = inp.dataset.slottime.split(":"); setSlotTime(did, mid, inp.value); }));
    el.querySelectorAll("[data-startmatch]").forEach(b => b.addEventListener("click", () => { const [did, mid] = b.dataset.startmatch.split(":"); startStamp(did, mid); }));
    el.querySelectorAll("[data-finishmatch]").forEach(b => b.addEventListener("click", () => { const [did, mid] = b.dataset.finishmatch.split(":"); finishStamp(did, mid); }));
    el.querySelectorAll("[data-resettime]").forEach(b => b.addEventListener("click", () => { const [did, mid] = b.dataset.resettime.split(":"); resetStamp(did, mid); }));
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
