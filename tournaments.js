// Court Sense — Tournaments module.
// Create tournaments (round-robin or single elimination), add divisions
// (category + discipline + letter grade), and enter teams from the roster.
// Matches, standings and scheduling are later phases.
import { TIERS, tierOf } from "./engine.js";

const CATS = [["womens", "Women's"], ["mens", "Men's"], ["mixed", "Mixed"]];
const DISCS = [["doubles", "Doubles"], ["singles", "Singles"]];
const GRADES = TIERS.map(t => t.cls).slice().reverse(); // A1 (highest) … D2 (lowest)

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

  let openId = null, newOpen = false, build = null; // build = { divisionId, slots: [playerId|null,…] }

  const findDiv = id => { const t = findT(openId); return t && t.divisions.find(d => d.id === id); };

  function render() {
    ctx.mount.innerHTML = openId ? detailHtml(findT(openId)) : listHtml();
    wire();
  }

  /* ---------- list + create ---------- */
  function listHtml() {
    let h = `<div class="row spread wrap" style="align-items:flex-end">
      <div><div class="eyebrow">Competitions</div><h2 style="font-size:22px">Tournaments</h2></div>
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
    h += `<div class="card pad">
      <div class="eyebrow" style="margin-bottom:10px">Add a division</div>
      <div class="row wrap" style="gap:8px;align-items:flex-end">
        <label class="field">Category<select id="dv_cat">${CATS.map(c => `<option value="${c[0]}">${c[1]}</option>`).join("")}</select></label>
        <label class="field">Type<select id="dv_disc">${DISCS.map(d => `<option value="${d[0]}">${d[1]}</option>`).join("")}</select></label>
        <label class="field">Grade<select id="dv_grade">${GRADES.map(g => `<option>${g}</option>`).join("")}</select></label>
        <button class="btn primary" id="dv_add">Add division</button>
      </div></div>`;
    if (!t.divisions.length) h += `<p class="tiny faint" style="margin:0">No divisions yet. Add one (e.g. Women's Doubles · C1), then enter teams from your roster.</p>`;
    h += `<div class="stack" style="gap:12px">` + t.divisions.map(d => divisionHtml(t, d)).join("") + `</div>`;
    return h;
  }
  function divisionHtml(t, d) {
    let h = `<div class="card pad" data-div="${d.id}">
      <div class="row spread" style="align-items:flex-start">
        <div><div class="divtitle">${divLabel(d)}</div>
          <div class="tiny muted">${d.teams.length} team${d.teams.length !== 1 ? "s" : ""}</div></div>
        <button class="qbtn qx" data-deldiv="${d.id}" title="Remove division">×</button>
      </div>`;
    if (d.teams.length) h += `<div class="stack" style="gap:6px;margin-top:10px">` + d.teams.map((tm, i) => teamRow(d, tm, i)).join("") + `</div>`;
    h += teamBuilderHtml(d);
    return h + `</div>`;
  }
  function teamRow(d, tm, i) {
    const names = tm.players.map(pid => {
      const p = ctx.byId(pid);
      return p ? `${esc(p.name)} <span class="gradetag">${gradeOf(pid)}</span>` : "?";
    }).join(` <span class="faint">/</span> `);
    return `<div class="trow"><span class="tnum num">${i + 1}</span><span class="grow">${names}</span>
      <button class="qbtn qx" data-delteam="${d.id}:${tm.id}" title="Remove team">×</button></div>`;
  }
  function teamBuilderHtml(d) {
    if (!build || build.divisionId !== d.id) {
      return `<button class="btn sm" data-buildteam="${d.id}" style="margin-top:10px">+ Add team</button>`;
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
      <div class="eyebrow" style="margin-bottom:6px">New team — ${teamSize(d2) === 1 ? "1 player" : "2 players"}</div>
      <div class="row wrap" style="gap:8px;margin-bottom:8px">${slots}</div>
      <input type="text" id="tb_search" placeholder="Search roster — ${catLabel(d.category)} ${d.grade} highlighted" autocomplete="off">
      <div id="tb_results" class="stack" style="gap:5px;margin-top:6px"></div>
      <div class="row" style="gap:8px;justify-content:flex-end;margin-top:8px">
        <button class="btn ghost sm" data-cancelbuild="1">Cancel</button>
        <button class="btn primary sm" data-addteam="${d.id}" ${full ? "" : "disabled"}>Add team</button>
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
  function addDivision() {
    const el = ctx.mount, t = findT(openId); if (!t) return;
    const category = el.querySelector("#dv_cat").value;
    const discipline = el.querySelector("#dv_disc").value;
    const grade = el.querySelector("#dv_grade").value;
    if (t.divisions.some(d => d.category === category && d.discipline === discipline && d.grade === grade)) return;
    t.divisions.push({ id: uid("d"), category, discipline, grade, teams: [], matches: [] });
    ctx.save(); render();
  }
  function pickPlayer(pid) {
    if (!build) return;
    const i = build.slots.indexOf(null);
    if (i < 0) return;
    build.slots[i] = pid;
    render();
  }
  function addTeam(divId) {
    const d = findDiv(divId); if (!d || !build) return;
    if (build.slots.some(x => !x)) return;
    d.teams.push({ id: uid("tm"), players: build.slots.slice() });
    build = null; ctx.save(); render();
  }

  /* ---------- wiring ---------- */
  function wire() {
    const el = ctx.mount, q = s => el.querySelector(s);
    q("#tNew") && q("#tNew").addEventListener("click", () => { newOpen = true; render(); });
    q("#tf_cancel") && q("#tf_cancel").addEventListener("click", () => { newOpen = false; render(); });
    q("#tf_create") && q("#tf_create").addEventListener("click", createTournament);
    el.querySelectorAll("[data-open]").forEach(c => c.addEventListener("click", () => { openId = c.dataset.open; newOpen = false; build = null; render(); }));
    q("#tBack") && q("#tBack").addEventListener("click", () => { openId = null; build = null; render(); });
    q("#tDelete") && q("#tDelete").addEventListener("click", () => {
      if (confirm("Delete this tournament? This can't be undone.")) { ctx.state.tournaments = tournaments().filter(t => t.id !== openId); openId = null; build = null; ctx.save(); render(); }
    });
    q("#dv_add") && q("#dv_add").addEventListener("click", addDivision);
    el.querySelectorAll("[data-deldiv]").forEach(b => b.addEventListener("click", () => { const t = findT(openId); if (t) { t.divisions = t.divisions.filter(d => d.id !== b.dataset.deldiv); ctx.save(); render(); } }));
    el.querySelectorAll("[data-delteam]").forEach(b => b.addEventListener("click", () => { const [did, tid] = b.dataset.delteam.split(":"); const d = findDiv(did); if (d) { d.teams = d.teams.filter(tm => tm.id !== tid); ctx.save(); render(); } }));
    el.querySelectorAll("[data-buildteam]").forEach(b => b.addEventListener("click", () => { const d = findDiv(b.dataset.buildteam); if (d) { build = { divisionId: d.id, slots: new Array(teamSize(d)).fill(null) }; render(); } }));
    el.querySelectorAll("[data-cancelbuild]").forEach(b => b.addEventListener("click", () => { build = null; render(); }));
    el.querySelectorAll("[data-unbuild]").forEach(b => b.addEventListener("click", () => { if (build) { build.slots[+b.dataset.unbuild] = null; render(); } }));
    el.querySelectorAll("[data-addteam]").forEach(b => b.addEventListener("click", () => addTeam(b.dataset.addteam)));
    const sb = q("#tb_search");
    if (sb) {
      sb.addEventListener("input", updateBuildResults);
      const results = q("#tb_results");
      // results are (re)built by updateBuildResults after this wiring, so delegate the picks
      if (results) results.addEventListener("click", e => { const b = e.target.closest("[data-pick]"); if (b) pickPlayer(b.dataset.pick); });
      updateBuildResults();
      sb.focus();
    }
  }

  return { render };
}
