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
