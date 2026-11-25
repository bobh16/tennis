// Court Sense — rating + matchmaking engine (pure logic, no DOM, no storage).

export const BASE_K = 160;   // max Elo-point swing for a brand-new player
export const REL_SOFT = 8;   // games needed before reliability ~50%
export const REL_CAP = 0.97; // reliability never claims total certainty

// Level bands. A player's number maps to the highest band whose `min` it reaches.
// Eight letter grades, D2 (lowest) up to A1 (highest). `key` is the colour group.
export const TIERS = [
  { min: 0,   name: "Beginner",           cls: "D2", key: "d" },
  { min: 2.5, name: "Improver",           cls: "D1", key: "d" },
  { min: 2.9, name: "Lower Intermediate", cls: "C2", key: "c" },
  { min: 3.3, name: "Intermediate",       cls: "C1", key: "c" },
  { min: 3.7, name: "Upper Intermediate", cls: "B2", key: "b" },
  { min: 4.1, name: "Advanced",           cls: "B1", key: "b" },
  { min: 4.5, name: "Open",               cls: "A2", key: "a" },
  { min: 4.9, name: "Elite",              cls: "A1", key: "a" },
];
export function tierOf(r) {
  let t = TIERS[0];
  for (const x of TIERS) if (r >= x.min) t = x;
  return t;
}

export function relLabel(r) { return r < 0.4 ? "Provisional" : r < 0.72 ? "Firming" : "Reliable"; }
export function relClass(r) { return r < 0.4 ? "rel-prov"   : r < 0.72 ? "rel-firm" : "rel-settled"; }

// Expected win share for team A, from the two team-average ratings.
// rating*400 = Elo points, so (sB - sA)/400 reduces to (bAvg - aAvg).
export function expected(aAvg, bAvg) { return 1 / (1 + Math.pow(10, bAvg - aAvg)); }

const pk = (a, b) => [a, b].sort().join("|");

// Apply one finished court's result: move all four ratings, update records and
// partner/opponent history. Mutates the player objects. Returns the list of changes.
export function applyResult(court, players, round, pairHist, oppHist) {
  const byId = id => players.find(p => p.id === id);
  const A = court.teamA.map(byId), B = court.teamB.map(byId);
  const aAvg = A.reduce((s, p) => s + p.rating, 0) / A.length;
  const bAvg = B.reduce((s, p) => s + p.rating, 0) / B.length;
  const expA = expected(aAvg, bAvg), expB = 1 - expA;
  const tot = court.scoreA + court.scoreB;
  const actA = tot === 0 ? 0.5 : court.scoreA / tot, actB = 1 - actA;
  const aWon = court.scoreA > court.scoreB;
  const changes = [];
  function upd(pl, exp, act, won) {
    const K = BASE_K * (1 - pl.reliability * 0.8); // settled ratings move less
    const old = pl.rating;
    let nr = old + (K * (act - exp)) / 400;
    nr = Math.max(1.5, Math.min(6.0, Math.round(nr * 1000) / 1000));
    pl.delta = Math.round((nr - old) * 1000) / 1000;
    pl.rating = nr;
    pl.games++; won ? pl.wins++ : pl.losses++;
    pl.reliability = Math.min(REL_CAP, pl.games / (pl.games + REL_SOFT));
    pl.gamesTonight = (pl.gamesTonight || 0) + 1;
    pl.lastRound = round;
    changes.push({ id: pl.id, name: pl.name, old, nw: nr, d: pl.delta, won });
  }
  A.forEach(p => upd(p, expA, actA, aWon));
  B.forEach(p => upd(p, expB, actB, !aWon));
  const bump = (map, a, b) => { const k = pk(a, b); map[k] = (map[k] || 0) + 1; };
  if (A.length > 1) bump(pairHist, A[0].id, A[1].id);
  if (B.length > 1) bump(pairHist, B[0].id, B[1].id);
  for (const a of court.teamA) for (const b of court.teamB) bump(oppHist, a, b);
  return changes;
}

// Build one round of courts from the players present.
// Queue = first come, first served: fewest games tonight, then earliest arrival.
export function generateRound(present, courtsAvail, round, pairHist, oppHist) {
  const nCourts = Math.min(courtsAvail, Math.floor(present.length / 4));
  if (nCourts < 1) return null;
  const need = nCourts * 4;
  const ranked = [...present].sort((a, b) =>
    ((a.gamesTonight || 0) - (b.gamesTonight || 0)) || ((a.arr || 0) - (b.arr || 0)));
  const playing = ranked.slice(0, need);
  const bench = ranked.slice(need).map(p => p.id);
  const bySkill = [...playing].sort((a, b) => b.rating - a.rating); // similar levels share a court
  const courts = [];
  for (let c = 0; c < nCourts; c++) {
    courts.push(bestPairing(bySkill.slice(c * 4, c * 4 + 4), c + 1, pairHist, oppHist));
  }
  return { courts, bench };
}

// Of the 3 ways to split 4 players into 2 teams, pick the most balanced,
// breaking ties toward fresh partner/opponent combinations.
export function bestPairing(four, courtNo, pairHist, oppHist) {
  // Singles: two players, one per side — nothing to optimise.
  if (four.length === 2) {
    return { court: courtNo, teamA: [four[0].id], teamB: [four[1].id], scoreA: 0, scoreB: 0 };
  }
  const combos = [[[0, 1], [2, 3]], [[0, 2], [1, 3]], [[0, 3], [1, 2]]];
  let best = null, bestCost = 1e9;
  for (const [tA, tB] of combos) {
    const A = [four[tA[0]], four[tA[1]]], B = [four[tB[0]], four[tB[1]]];
    const imbalance = Math.abs((A[0].rating + A[1].rating) - (B[0].rating + B[1].rating));
    const repeat = (pairHist[pk(A[0].id, A[1].id)] || 0) + (pairHist[pk(B[0].id, B[1].id)] || 0);
    let opp = 0; for (const a of A) for (const b of B) opp += (oppHist[pk(a.id, b.id)] || 0);
    const cost = imbalance + 0.18 * repeat + 0.05 * opp;
    if (cost < bestCost) { bestCost = cost; best = { A, B }; }
  }
  return {
    court: courtNo,
    teamA: [best.A[0].id, best.A[1].id],
    teamB: [best.B[0].id, best.B[1].id],
    scoreA: 0, scoreB: 0,
  };
}

// Choose the next four to play from the waiting queue: the player who has
// waited longest (front of queue) always plays, plus the three nearest to them
// in level from a window near the front — so matches stay level-similar without
// letting someone far back jump the line. Returns an array of 4 ids, or null.
export function pickGroup(queue, getPlayer, size = 4, windowSize = 8) {
  if (queue.length < size) return null;
  const need = size - 1;
  const anchorId = queue[0];
  const anchor = getPlayer(anchorId);
  const pool = queue.slice(1, 1 + Math.max(need, windowSize))
    .map(id => ({ id, p: getPlayer(id) }))
    .sort((a, b) => Math.abs(a.p.rating - anchor.rating) - Math.abs(b.p.rating - anchor.rating));
  return [anchorId, ...pool.slice(0, need).map(x => x.id)];
}
// Back-compat alias — a foursome is just a group of four.
export function pickFoursome(queue, getPlayer, windowSize = 8) {
  return pickGroup(queue, getPlayer, 4, windowSize);
}

let idCounter = 0;
export function makePlayer(name, rating = 3.5, gender = null) {
  idCounter++;
  const r = Math.max(1.5, Math.min(6, rating));
  return {
    id: "p" + Date.now().toString(36) + "-" + idCounter.toString(36),
    name: name.trim(), rating: Math.round(r * 100) / 100, gender, age: null, ageGroup: "adult", reliability: 0,
    games: 0, wins: 0, losses: 0, present: false, arr: 0, gamesTonight: 0, lastRound: -99, delta: 0,
  };
}

// Parse pasted text or CSV into {name, rating} rows. One member per line,
// optional level after a comma or tab. Skips blanks, a "Name" header, and duplicates.
function parseGender(s) {
  if (!s) return null;
  s = s.trim().toLowerCase();
  if (/^(f|w|female|woman|women|girl|ladies)/.test(s)) return "f";
  if (/^(m|male|man|men|boy)/.test(s)) return "m";
  return null;
}
export function parseRoster(text) {
  const out = [], seen = new Set();
  (text || "").split(/\r?\n/).forEach(line => {
    line = line.trim();
    if (!line) return;
    const parts = line.split(/[,\t]/).map(s => s.trim().replace(/^"(.*)"$/, "$1").trim());
    const name = parts[0];
    if (!name || /^name$/i.test(name)) return;
    let lvl = 3.5, g = null;
    for (let i = 1; i < parts.length; i++) {
      const n = parseFloat(parts[i]);
      if (isFinite(n) && n >= 1 && n <= 10) lvl = Math.max(1.5, Math.min(6, n));
      else { const gg = parseGender(parts[i]); if (gg) g = gg; }
    }
    const key = name.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ name, rating: Math.round(lvl * 100) / 100, gender: g });
  });
  return out;
}

// Demo roster for trying the app before real members are imported.
const FIRST = ["James","Maria","David","Lin","Omar","Priya","Tom","Chloe","Ben","Sofia","Raj","Elena","Marcus","Yuki","Carlos","Nina","Pete","Amara","Hugo","Grace","Leo","Mina","Sam","Tara","Kofi","Isabel","Dan","Wei"];
const LAST  = ["Reyes","Chen","Okafor","Novak","Haddad","Singh","Flores","Park","Bauer","Rossi","Mehta","Volkov","Doyle","Tanaka","Mendez","Larsen","Quinn","Diallo","Weber","Owens","Santos","Cho","Patel","Brooks","Asare","Marin","Hughes","Zhang"];
export function samplePlayers() {
  const players = [];
  for (let i = 0; i < 28; i++) {
    const r = Math.round((2.6 + Math.random() * 2.2) * 100) / 100;
    const games = Math.floor(5 + Math.random() * 45);
    const p = makePlayer(FIRST[i] + " " + LAST[i][0] + ".", r, Math.random() < 0.5 ? "f" : "m");
    p.games = games;
    p.reliability = Math.min(REL_CAP, games / (games + REL_SOFT));
    p.wins = Math.round(games * (0.35 + Math.random() * 0.3));
    p.losses = games - p.wins;
    players.push(p);
  }
  return players;
}
