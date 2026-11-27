// Court Sense — tennis game/set scoring engine (pure, no DOM).
// A match in "tennis" format is one SET of games. The stored result lives in the
// usual scoreA/scoreB as GAMES won (e.g. 6–4), so standings/results need no special
// case. Within a game we track points (0/15/30/40/deuce/advantage) on transient
// fields so a match can be paused and resumed:
//   scoreA / scoreB … games won in the set
//   tpA / tpB       … raw points in the CURRENT game (0,1,2,3,4,…)
//   tDeuces         … how many times this game has reached deuce (40–40)
//   tInTb           … true while playing the set tiebreak at G–G
//   tbA / tbB       … points in that tiebreak
//   done            … set decided
//
// Config (from the tournament): { games:G, deuces:N, tb:bool }
//   games  G … first to G games wins the set (win by 2). Default 6.
//   deuces N … play N deuces with advantage, then the next deuce is sudden death.
//              N = 0 means no-ad (first deuce is sudden death). Default 3.
//   tb       … play a 7-point tiebreak at G–G (default true).

export const TENNIS_POINTS = ["0", "15", "30", "40"];

export function tennisCfg(t) {
  return {
    games: Math.max(1, (t && t.tGames) || 6),
    deuces: Math.max(0, (t && t.tDeuces != null) ? t.tDeuces : 3),
    tb: !(t && t.tTb === false),
  };
}

// Label for one side's point in the current game, aware of deuce/advantage/sudden death.
// Returns a short token like "0", "15", "30", "40", "40" (deuce shown separately),
// or "Ad". Use gameStateLabel for the combined human string.
export function pointLabel(p) {
  return p <= 3 ? TENNIS_POINTS[p] : "40";
}

// A human label for the whole game score, e.g. "30–15", "Deuce",
// "Advantage A", "Sudden death". `names` optionally maps A/B to display names.
export function gameStateLabel(m, cfg, names) {
  const a = m.tpA || 0, b = m.tpB || 0;
  const nm = s => (names && names[s]) || ("Team " + s);
  if (a >= 3 && b >= 3) {
    if (a === b) {
      const sudden = (m.tDeuces || 0) > (cfg.deuces || 0);
      return sudden ? "Sudden death — next point wins" : "Deuce";
    }
    return "Advantage " + nm(a > b ? "A" : "B");
  }
  return `${pointLabel(a)}–${pointLabel(b)}`;
}

// Is the game currently at a sudden-death point (deuce, past the deuce allowance)?
export function isSuddenDeath(m, cfg) {
  const a = m.tpA || 0, b = m.tpB || 0;
  return a >= 3 && b >= 3 && a === b && (m.tDeuces || 0) > (cfg.deuces || 0);
}

// Add one point to `side` ("A"|"B"). Mutates m. Returns an event string for the UI:
// "point" | "game" | "set" | "noop" (ignored, e.g. match already decided).
export function addTennisPoint(m, side, cfg) {
  if (m.done) return "noop";
  const win = side, lose = side === "A" ? "B" : "A";

  if (m.tInTb) return tiebreakPoint(m, win, lose, cfg);

  let pw = m["tp" + win] || 0;
  const pl = m["tp" + lose] || 0;
  const atDeuce = pw >= 3 && pl >= 3 && pw === pl;
  const sudden = atDeuce && (m.tDeuces || 0) > (cfg.deuces || 0);
  pw += 1;
  m["tp" + win] = pw;

  let gameWon = sudden || (pw >= 4 && pw - pl >= 2);
  if (!gameWon && pw >= 3 && pl >= 3 && pw === pl) m.tDeuces = (m.tDeuces || 0) + 1; // reached a new deuce

  if (!gameWon) return "point";
  // game won → bump games, reset the game, hand serve to the other team
  m["score" + win] = (m["score" + win] || 0) + 1;
  m.tpA = 0; m.tpB = 0; m.tDeuces = 0;
  m.tServer = (m.tServer || "A") === "A" ? "B" : "A";
  return checkSet(m, cfg) ? "set" : "game";
}

function tiebreakPoint(m, win, lose, cfg) {
  m["tb" + win] = (m["tb" + win] || 0) + 1;
  const tw = m["tb" + win], tl = m["tb" + lose] || 0;
  if (tw >= 7 && tw - tl >= 2) {
    // tiebreak (and the set) won
    m["score" + win] = (cfg.games || 6) + 1; // 7–6
    m.tInTb = false; m.done = true;
    return "set";
  }
  return "point";
}

// After a game, decide whether the set is over or a tiebreak begins. Returns true if the set ended.
function checkSet(m, cfg) {
  const G = cfg.games || 6, a = m.scoreA || 0, b = m.scoreB || 0;
  if (cfg.tb && a === G && b === G) { m.tInTb = true; m.tbA = 0; m.tbB = 0; return false; }
  if ((a >= G || b >= G) && Math.abs(a - b) >= 2) { m.done = true; return true; }
  return false;
}

// Undo a single point (best-effort). Because the game resets on each won game, undo
// within a game is exact; undoing across a game boundary is not reconstructable, so
// the umpire UI should confirm the game/set score instead. Returns true if it changed.
export function undoTennisPoint(m, side, cfg) {
  if (m.tInTb) {
    const v = m["tb" + side] || 0;
    if (v > 0) { m["tb" + side] = v - 1; return true; }
    return false;
  }
  const v = m["tp" + side] || 0;
  if (v > 0) {
    m["tp" + side] = v - 1;
    if (!((m.tpA || 0) >= 3 && (m.tpB || 0) >= 3 && (m.tpA || 0) === (m.tpB || 0))) {
      // stepped out of a deuce — drop the last deuce count
      if ((m.tDeuces || 0) > 0 && (m.tpA || 0) < 3) m.tDeuces = 0;
    }
    return true;
  }
  return false;
}
