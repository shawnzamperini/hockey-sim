// Betting-line math: turn the simulation's distributions into the
// probabilities of each side of a sportsbook line, fair odds, and the
// expected value of a bet at the book's price.

/** Fair (no-vig) American odds for a probability. */
export function americanOdds(p) {
  if (!(p > 0 && p < 1)) return null;
  return p >= 0.5 ? -Math.round((100 * p) / (1 - p)) : Math.round((100 * (1 - p)) / p);
}

/**
 * Parse a sportsbook price. American odds ("-110", "−110", "+135", "135")
 * or decimal odds ("1.91", "2.35", up to 30). Returns { american, profit } where
 * profit is the winnings per 1 staked, or null if it isn't a price.
 */
export function parseOdds(text) {
  const t = String(text ?? "").trim().replace(/[−–—]/g, "-").replace(/\s+/g, "");
  if (!/^[+-]?\d+(\.\d+)?$/.test(t)) return null;
  const x = Number(t);
  if (Math.abs(x) >= 100) {
    const profit = x > 0 ? x / 100 : 100 / -x;
    return { american: Math.round(x), profit };
  }
  // Decimal odds (1.01 to 30); numbers between 30 and 100 are neither.
  if (x > 1 && x <= 30 && !t.startsWith("-") && !t.startsWith("+")) {
    const profit = x - 1;   // decimal odds
    return { american: profit >= 1 ? Math.round(100 * profit) : -Math.round(100 / profit), profit };
  }
  return null;
}

/**
 * Expected profit per 1 staked: win `profit` with pWin, lose the stake with
 * pLose; a push (the rest) returns the stake.
 */
export const expectedValue = (pWin, pLose, profit) => pWin * profit - pLose;

/** Fair odds for one side when a push is possible (the bet is refunded on a push). */
export const fairOdds = (pWin, pLose) => americanOdds(pWin + pLose > 0 ? pWin / (pWin + pLose) : NaN);

/** The book's implied chance of winning (with its margin left in). */
export const impliedProb = (profit) => 1 / (1 + profit);

/** Over/under at `line` from P(total = t): { over, under, push }. */
export function totalLine(dist, line) {
  let over = 0, under = 0, push = 0;
  dist.forEach((p, t) => { if (t > line) over += p; else if (t < line) under += p; else push += p; });
  return { over, under, push };
}

/**
 * A spread bet on one team, from P(home - away = m) (index m + offset):
 * the team covers if its margin + handicap > 0 (handicap -1.5 = must win by
 * 2; +1.5 = must not lose by 2 or more). Returns { win, lose, push }.
 */
export function spreadLine(marginDist, offset, side, handicap) {
  let win = 0, lose = 0, push = 0;
  marginDist.forEach((p, i) => {
    const m = (i - offset) * (side === "home" ? 1 : -1) + handicap;
    if (m > 0) win += p; else if (m < 0) lose += p; else push += p;
  });
  return { win, lose, push };
}

/** The half-goal total line closest to a coin flip (where books usually set it). */
export function defaultTotal(dist) {
  let best = 5.5, gap = Infinity;
  for (let line = 3.5; line <= 9.5; line += 1) {
    const g = Math.abs(totalLine(dist, line).over - 0.5);
    if (g < gap) { gap = g; best = line; }
  }
  return best;
}

// ------------------------------------------------------------------ bet sizing

/**
 * Default sizing settings. Everything is in units: the bankroll is
 * `bankrollUnits` units (100 = the usual convention that one unit is 1% of
 * the bankroll), and `unitSize` is a unit in dollars (for display only).
 */
export const SIZING_DEFAULTS = Object.freeze({
  unitSize: 10,          // dollars per unit
  kellyFraction: 0.25,   // quarter Kelly
  modelWeight: 0.5,      // how far to trust the model vs the market (0..1)
  maxUnits: 3,           // cap per bet
  bankrollUnits: 100,    // bankroll in units (1 unit = 1% of it)
});

/**
 * Kelly fraction of the bankroll for one bet: win `profit` per 1 staked with
 * pWin, lose the stake with pLose, otherwise a push (stake back). Maximizes
 * the expected log of the bankroll: f* = (b·p − q) / (b·(p + q)), which is
 * edge / b without pushes. 0 when there's no edge.
 */
export function kellyFraction(pWin, pLose, profit) {
  if (!(profit > 0) || !(pWin + pLose > 0)) return 0;
  const f = (profit * pWin - pLose) / (profit * (pWin + pLose));
  return f > 0 ? f : 0;
}

/**
 * The market's probability that this side wins (ignoring pushes), from the
 * book's prices. With the other side's price, the bookmaker's margin is
 * removed exactly (proportionally); without it, a typical two-way margin
 * (4.5%) is assumed.
 */
export function marketProb(profit, otherProfit = null) {
  const mine = 1 / (1 + profit);
  if (otherProfit > 0) return mine / (mine + 1 / (1 + otherProfit));
  return Math.min(0.999, mine / 1.045);
}

/**
 * Suggested stake in units for one side of a line.
 * @param pWin,pLose  the model's chances (the rest is a push)
 * @param profit      the book's payout per 1 staked
 * @param otherProfit the other side's payout, if entered (for the market's chance)
 * @param s           sizing settings (SIZING_DEFAULTS)
 * @returns { units, kelly, pAdj, edge } — units 0 means don't bet. pAdj is
 *   the win chance after blending the model with the market by modelWeight,
 *   edge the expected profit per 1 staked at that chance, kelly the full
 *   Kelly fraction of the bankroll.
 */
export function suggestStake(pWin, pLose, profit, otherProfit, s = SIZING_DEFAULTS) {
  const settled = pWin + pLose;
  if (!(settled > 0) || !(profit > 0)) return { units: 0, kelly: 0, pAdj: pWin, edge: 0 };
  const w = Math.min(1, Math.max(0, s.modelWeight));
  const pModel = pWin / settled;                          // chance of winning when it settles
  const pAdj = w * pModel + (1 - w) * marketProb(profit, otherProfit);
  const win = pAdj * settled, lose = settled - win;
  const kelly = kellyFraction(win, lose, profit);
  const raw = s.kellyFraction * kelly * s.bankrollUnits;
  const units = Math.min(s.maxUnits, Math.round(raw * 10) / 10);   // to 0.1 units
  return { units: units >= 0.1 ? units : 0, kelly, pAdj, edge: expectedValue(win, lose, profit) };
}

/** Format units: "1.5u". */
export const unitsText = (u) => `${Number(u.toFixed(2))}u`;
