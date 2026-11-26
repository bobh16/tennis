// Court Sense — cloud sync (Supabase REST, no library).
// Collaborative: PULL remote, 3-way MERGE against the last-synced snapshot, then
// PUSH the merged result. The merge is per-entity, so one person editing the
// schedule and another entering scores both stick — they touch different matches.
// Offline-first: runs only when called and online; the app works without it.
import { SUPABASE_URL, SUPABASE_KEY } from "./config.js";

const BASE = SUPABASE_URL.replace(/\/$/, "") + "/rest/v1";
const HEADERS = {
  apikey: SUPABASE_KEY,
  Authorization: "Bearer " + SUPABASE_KEY,
  "Content-Type": "application/json",
};

export function configured() {
  return /^https:\/\/.+\.supabase\.co/.test(SUPABASE_URL) && /^sb_|^eyJ/.test(SUPABASE_KEY);
}

// Last-synced snapshots, by id — the "base" for 3-way merge. In memory: good for
// a live session (the app stays open at the event); a reload re-seeds on first sync.
const base = { tournaments: {}, members: {} };
const clone = x => JSON.parse(JSON.stringify(x));
const stable = x => JSON.stringify(x);

async function upsert(table, rows) {
  if (!rows.length) return;
  const res = await fetch(`${BASE}/${table}?on_conflict=id`, {
    method: "POST",
    headers: { ...HEADERS, Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify(rows),
  });
  if (!res.ok) throw new Error(`${table}: ${res.status} ${await res.text()}`);
}
async function selectAll(table) {
  const res = await fetch(`${BASE}/${table}?select=*`, { headers: HEADERS });
  if (!res.ok) throw new Error(`${table}: ${res.status} ${await res.text()}`);
  return res.json();
}
async function deleteRow(table, id) {
  const res = await fetch(`${BASE}/${table}?id=eq.${encodeURIComponent(id)}`, { method: "DELETE", headers: HEADERS });
  if (!res.ok && res.status !== 404) throw new Error(`${table} delete: ${res.status} ${await res.text()}`);
}

/* ---- row mapping (app objects <-> db rows) ---- */
const nowISO = () => new Date().toISOString();
const TFIELDS = ["alternate", "slotMin", "target", "warmupMin", "breakMin", "switchEvery"];
function memberRows(players) {
  return players.map(p => ({
    id: p.id, name: p.name, rating: p.rating, gender: p.gender || null,
    reliability: p.reliability || 0, games: p.games || 0, wins: p.wins || 0, losses: p.losses || 0,
    updated_at: nowISO(),
  }));
}
function tournamentRows(ts) {
  return (ts || []).map(t => {
    const data = { divisions: t.divisions || [] };
    TFIELDS.forEach(k => { if (t[k] !== undefined) data[k] = t[k]; });
    return {
      id: t.id, name: t.name, type: t.type, courts: t.courts,
      start_date: t.startDate || null, end_date: t.endDate || null,
      data, updated_at: nowISO(),
    };
  });
}
function rowToMember(r) {
  return {
    id: r.id, name: r.name, rating: Number(r.rating), gender: r.gender,
    reliability: Number(r.reliability) || 0, games: r.games || 0, wins: r.wins || 0, losses: r.losses || 0,
    age: null, ageGroup: "adult", present: false, arr: 0, gamesTonight: 0, lastRound: -99, delta: 0,
  };
}
function rowToTournament(r) {
  const d = r.data || {};
  const t = {
    id: r.id, name: r.name, type: r.type, courts: r.courts,
    startDate: r.start_date, endDate: r.end_date,
    divisions: d.divisions || [], createdAt: Date.now(),
  };
  TFIELDS.forEach(k => { if (d[k] !== undefined) t[k] = d[k]; });
  return t;
}

/* ---- 3-way merge ---- */
// For a scalar/leaf: if local changed since the base, local wins; else take remote.
function pick(b, l, r) {
  if (b === undefined) return r !== undefined ? r : l;
  return stable(l) !== stable(b) ? l : r;
}
// For a list of {id,...} objects: union by id; present on one side only -> keep it;
// on both -> if local changed since base keep local, else take remote. `after`
// lets callers deep-merge children instead of taking a whole object.
function mergeList(bArr, lArr, rArr, after) {
  const byId = a => { const m = {}; (a || []).forEach(x => { m[x.id] = x; }); return m; };
  const B = byId(bArr), L = byId(lArr), R = byId(rArr);
  const out = [], seen = new Set();
  Object.keys(L).forEach(id => {
    seen.add(id);
    const l = L[id], r = R[id], b = B[id];
    if (!r) { out.push(l); return; }
    out.push(after ? after(b, l, r) : (b && stable(l) !== stable(b) ? l : r));
  });
  Object.keys(R).forEach(id => { if (!seen.has(id)) out.push(R[id]); }); // remote-only additions
  return out;
}
function mergeDivision(b, l, r) {
  b = b || {};
  const d = { ...r };
  ["category", "discipline", "grade", "day", "callTime", "rotOrder"].forEach(k => { d[k] = pick(b[k], l[k], r[k]); });
  d.teams = mergeList(b.teams, l.teams, r.teams);
  d.matches = mergeList(b.matches, l.matches, r.matches)
    .sort((x, y) => ((x.ord != null ? x.ord : x.slot || 0) - (y.ord != null ? y.ord : y.slot || 0)));
  return d;
}
function mergeTournament(b, l, r) {
  b = b || {};
  const t = { ...r };
  ["name", "type", "courts", "startDate", "endDate", ...TFIELDS].forEach(k => { t[k] = pick(b[k], l[k], r[k]); });
  t.divisions = mergeList(b.divisions, l.divisions, r.divisions, mergeDivision);
  return t;
}
function mergeMember(b, l, r) {
  // choose by whether the synced fields changed locally; always keep local-only fields
  const chosen = (b && stable(syncKey(l)) !== stable(syncKey(b))) ? l : r;
  return { ...chosen, age: l.age, ageGroup: l.ageGroup, present: l.present, arr: l.arr, gamesTonight: l.gamesTonight, lastRound: l.lastRound, delta: l.delta };
}
const syncKey = p => ({ name: p.name, rating: p.rating, gender: p.gender, reliability: p.reliability, games: p.games, wins: p.wins, losses: p.losses });

// Pull, merge against base, push merged, reseed base. Mutates S; caller persists + re-renders.
// Returns a change flag so the caller can skip a re-render when nothing moved.
export async function syncNow(S) {
  S.tournaments = S.tournaments || [];
  const beforeT = stable(S.tournaments), beforeM = stable(S.players);

  // propagate local deletions to the cloud before merging, so they don't come back
  const tombstones = S.deletedTournaments || [];
  for (const id of tombstones) { await deleteRow("tournaments", id); delete base.tournaments[id]; }

  const [rm, rt] = await Promise.all([selectAll("members"), selectAll("tournaments")]);
  const remoteT = rt.map(rowToTournament).filter(t => !tombstones.includes(t.id));
  const remoteM = rm.map(rowToMember);
  S.deletedTournaments = [];

  S.tournaments = mergeList(base.tournaments ? Object.values(base.tournaments) : [], S.tournaments, remoteT, mergeTournament);
  S.players = mergeList(base.members ? Object.values(base.members) : [], S.players, remoteM, mergeMember);

  await upsert("members", memberRows(S.players));
  await upsert("tournaments", tournamentRows(S.tournaments));

  base.tournaments = {}; S.tournaments.forEach(t => { base.tournaments[t.id] = clone(t); });
  base.members = {}; S.players.forEach(p => { base.members[p.id] = clone(p); });

  return { members: S.players.length, tournaments: S.tournaments.length, changed: stable(S.tournaments) !== beforeT || stable(S.players) !== beforeM };
}
