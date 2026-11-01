// Bet tracking: settling bets from final scores, and the progress numbers.
// Pure functions shared by the app (Bets tab) and the hourly settlement job
// (scripts/settle_bets.mjs).
//
// A bet: { market: "moneyline" | "spread" | "total", side: "home" | "away" |
// "over" | "under", line, odds_american, stake, model_win, model_push, ev,
// status, profit, ... } (columns of the bets table, supabase/schema.sql).

/** Winnings per 1 staked at American odds. */
export const payout = (american) => (american > 0 ? american / 100 : 100 / -american);

const FINAL_STATES = new Set(["OFF", "FINAL"]);

/**
 * Settle a bet against a game from games.json. Final scores count a shootout
 * winner as a goal, as sportsbooks settle puck lines and totals. Returns
 * null while the game isn't final, or { status, profit, final_home,
 * final_away, ended_in }. A canceled game voids the bet (stake returned).
 */
export function gradeBet(bet, game) {
  if (!game) return null;
  if (game.schedule === "CNCL") {
    return { status: "void", profit: 0, final_home: null, final_away: null, ended_in: null };
  }
  if (!FINAL_STATES.has(game.state)) return null;
  const h = game.home?.score, a = game.away?.score;
  if (!Number.isFinite(h) || !Number.isFinite(a)) return null;
  let m;   // > 0 the bet wins, < 0 it loses, 0 a push
  if (bet.market === "total") {
    m = bet.side === "over" ? h + a - bet.line : bet.line - (h + a);
  } else {
    const margin = bet.side === "home" ? h - a : a - h;
    m = margin + (bet.market === "spread" ? Number(bet.line) : 0);
  }
  const status = m > 0 ? "won" : m < 0 ? "lost" : "push";
  const stake = Number(bet.stake);
  const profit = status === "won" ? round2(stake * payout(bet.odds_american)) : status === "lost" ? -stake : 0;
  return { status, profit, final_home: h, final_away: a, ended_in: game.endedIn || null };
}

const round2 = (x) => Math.round(100 * x) / 100;

/** Mean and variance of one bet's profit if the model's chances are right. */
function betMoments(b) {
  const s = Number(b.stake), d = payout(b.odds_american);
  const p = Number(b.model_win), push = Number(b.model_push) || 0;
  if (!Number.isFinite(p)) return null;
  const q = Math.max(0, 1 - p - push);
  const mean = s * (p * d - q);
  return { mean, variance: s * s * (p * d * d + q) - mean * mean };
}

/**
 * Progress over a list of bets.
 * @returns { open, openStake, won, lost, push, staked, profit, roi,
 *            expected, sd, series: [{ t, profit, expected, lo, hi }] }
 * expected = profit the model predicted for the settled bets (sum of stake x
 * EV); sd = its standard deviation from luck alone, so a result outside
 * expected +/- 2 sd is unlikely if the model's chances were right.
 */
export function betStats(bets) {
  const out = { open: 0, openStake: 0, won: 0, lost: 0, push: 0, void: 0, staked: 0, profit: 0, roi: null,
    expected: 0, sd: 0, series: [] };
  let variance = 0;
  const settled = bets.filter((b) => ["won", "lost", "push"].includes(b.status))
    .sort((x, y) => String(x.settled_at || x.start_time).localeCompare(String(y.settled_at || y.start_time)));
  for (const b of bets) {
    if (b.status === "open") { out.open++; out.openStake += Number(b.stake); }
    if (b.status === "void") out.void++;
  }
  for (const b of settled) {
    out[b.status]++;
    out.staked += Number(b.stake);
    out.profit += Number(b.profit);
    const mo = betMoments(b);
    if (mo) { out.expected += mo.mean; variance += mo.variance; }
    const sd = Math.sqrt(variance);
    out.series.push({ t: b.settled_at || b.start_time, profit: round2(out.profit), expected: round2(out.expected),
      lo: round2(out.expected - 2 * sd), hi: round2(out.expected + 2 * sd) });
  }
  out.profit = round2(out.profit);
  out.expected = round2(out.expected);
  out.sd = round2(Math.sqrt(variance));
  out.roi = out.staked > 0 ? out.profit / out.staked : null;
  return out;
}

/** Human-readable bet description, e.g. "EDM −1.5", "Over 6.5", "TOR moneyline". */
export function describeBet(b) {
  const team = b.side === "home" ? b.home : b.away;
  if (b.market === "total") return `${b.side === "over" ? "Over" : "Under"} ${fmtLine(b.line)}`;
  if (b.market === "spread") return `${team} ${Number(b.line) > 0 ? "+" : "−"}${fmtLine(Math.abs(b.line))}`;
  return `${team} moneyline`;
}
const fmtLine = (x) => (Number.isInteger(Number(x)) ? String(Number(x)) : Number(x).toFixed(1));
