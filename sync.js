// Court Sense — cloud sync (Supabase REST, no library).
// Push the local roster + tournaments up, pull anything new down, merge.
// Offline-first: sync only runs when called and online; the app works without it.
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

/* ---- row mapping (app objects <-> db rows) ---- */
const nowISO = () => new Date().toISOString();
function memberRows(players) {
  return players.map(p => ({
    id: p.id, name: p.name, rating: p.rating, gender: p.gender || null,
    reliability: p.reliability || 0, games: p.games || 0, wins: p.wins || 0, losses: p.losses || 0,
    updated_at: nowISO(),
  }));
}
function tournamentRows(ts) {
  return (ts || []).map(t => ({
    id: t.id, name: t.name, type: t.type, courts: t.courts,
    start_date: t.startDate || null, end_date: t.endDate || null,
    data: { divisions: t.divisions || [] },
    updated_at: nowISO(),
  }));
}
function rowToMember(r) {
  return {
    id: r.id, name: r.name, rating: Number(r.rating), gender: r.gender,
    reliability: Number(r.reliability) || 0, games: r.games || 0, wins: r.wins || 0, losses: r.losses || 0,
    present: false, arr: 0, gamesTonight: 0, lastRound: -99, delta: 0,
  };
}
function rowToTournament(r) {
  return {
    id: r.id, name: r.name, type: r.type, courts: r.courts,
    startDate: r.start_date, endDate: r.end_date,
    divisions: (r.data && r.data.divisions) || [], createdAt: Date.now(),
  };
}

// Push local, then pull remote and add anything this device is missing.
// Record-level last-write-wins (our upsert wins for ids we own; remote adds
// records created on other devices). Mutates S; caller persists + re-renders.
export async function syncNow(S) {
  await upsert("members", memberRows(S.players));
  await upsert("tournaments", tournamentRows(S.tournaments || []));

  const [rm, rt] = await Promise.all([selectAll("members"), selectAll("tournaments")]);

  const haveM = new Set(S.players.map(p => p.id));
  rm.forEach(r => { if (!haveM.has(r.id)) S.players.push(rowToMember(r)); });

  S.tournaments = S.tournaments || [];
  const haveT = new Set(S.tournaments.map(t => t.id));
  rt.forEach(r => { if (!haveT.has(r.id)) S.tournaments.push(rowToTournament(r)); });

  return { members: rm.length, tournaments: rt.length };
}
