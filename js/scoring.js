// Scoring of predictions against results. Shared by the app (scorecard view)
// and the Node scripts (backtest, live tracking), so both are computed the
// same way.
//
// A prediction record:
//   { id, date: "YYYY-MM-DD", home, away,
//     pHome,      model's probability the home team wins (incl. OT/SO)
//     pBase,      standings-only baseline's probability (points %, see predict.mjs)
//     pOT, expTotal,   model's chance of overtime and expected total goals
//     result: { home, away, endedIn } }   absent until the game is final
//
// Metrics (lower is better for Brier and log loss):
//   Brier score  mean (p - y)^2. 0.25 = coin flip; NHL models typically land
//                around 0.23-0.24 because hockey is close to a coin flip.
//   Log loss     mean -[y ln p + (1-y) ln(1-p)]; punishes confident misses hard.
//   Skill        1 - Brier(model) / Brier(reference): the share of the
//                reference's error the model removes. Positive = better.
//   Calibration  among games given ~60%, does the team win ~60%?

export const HOME_RATE = 0.54;   // constant baseline: always give the home team 54%

const clamp = (p) => Math.min(1 - 1e-6, Math.max(1e-6, p));

export function homeWon(r) {
  return r.result.home > r.result.away ? 1 : 0;
}

export function completed(records) {
  return records.filter((r) => r.result && Number.isFinite(r.pHome));
}

function meanAndSe(xs) {
  const n = xs.length;
  if (!n) return { mean: NaN, se: NaN };
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  const v = n > 1 ? xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1) : 0;
  return { mean, se: Math.sqrt(v / n) };
}

/** Brier, log loss and pick accuracy for probabilities `ps` vs outcomes `ys`. */
function forecastScores(ps, ys) {
  let brier = 0, logLoss = 0, correct = 0;
  for (let i = 0; i < ps.length; i++) {
    const p = clamp(ps[i]), y = ys[i];
    brier += (p - y) ** 2;
    logLoss -= y ? Math.log(p) : Math.log(1 - p);
    correct += p === 0.5 ? 0.5 : (p > 0.5) === (y === 1) ? 1 : 0;
  }
  const n = ps.length || 1;
  return { brier: brier / n, logLoss: logLoss / n, accuracy: correct / n };
}

/**
 * Skill of `ps` relative to reference `qs`, with a standard error from the
 * per-game differences in squared error (paired, so it's much tighter than
 * comparing two Brier scores independently).
 */
function skill(ps, qs, ys) {
  const d = ps.map((p, i) => (qs[i] - ys[i]) ** 2 - (p - ys[i]) ** 2);
  const { mean, se } = meanAndSe(d);
  const ref = qs.reduce((a, q, i) => a + (q - ys[i]) ** 2, 0) / (ys.length || 1);
  return { skill: mean / ref, se: se / ref };
}

/**
 * Equal-count calibration bins: sort by predicted probability, split into
 * `bins` groups of (nearly) equal size, and compare the mean prediction with
 * the observed win rate in each. Equal counts keep every point equally
 * trustworthy.
 */
export function calibrationBins(ps, ys, bins = 10) {
  const idx = ps.map((_, i) => i).sort((a, b) => ps[a] - ps[b]);
  const k = Math.max(1, Math.min(bins, Math.floor(idx.length / 20) || 1));
  const out = [];
  for (let b = 0; b < k; b++) {
    const slice = idx.slice(Math.floor((b * idx.length) / k), Math.floor(((b + 1) * idx.length) / k));
    if (!slice.length) continue;
    const pred = slice.reduce((a, i) => a + ps[i], 0) / slice.length;
    const obs = slice.reduce((a, i) => a + ys[i], 0) / slice.length;
    out.push({ predicted: pred, observed: obs, n: slice.length, se: Math.sqrt(Math.max(obs * (1 - obs), 0.01) / slice.length) });
  }
  return out;
}

/** Score a set of prediction records. Returns null when nothing is final yet. */
export function scoreRecords(records, { bins = 10 } = {}) {
  const done = completed(records);
  if (!done.length) return null;
  const ys = done.map(homeWon);
  const model = done.map((r) => r.pHome);
  const base = done.map((r) => (Number.isFinite(r.pBase) ? r.pBase : HOME_RATE));
  const constant = done.map(() => HOME_RATE);

  // Monthly breakdown (by game date)
  const byMonth = new Map();
  done.forEach((r, i) => {
    const m = r.date.slice(0, 7);
    if (!byMonth.has(m)) byMonth.set(m, []);
    byMonth.get(m).push(i);
  });
  const months = [...byMonth.entries()].sort().map(([month, is]) => {
    const p = is.map((i) => model[i]), y = is.map((i) => ys[i]), c = is.map(() => HOME_RATE);
    return { month, n: is.length, ...forecastScores(p, y), ...skill(p, c, y) };
  });

  // Game-shape checks: did the model get overtime and scoring right on average?
  const withOT = done.filter((r) => Number.isFinite(r.pOT));
  const withTotal = done.filter((r) => Number.isFinite(r.expTotal));
  const shape = {
    predictedOT: withOT.reduce((a, r) => a + r.pOT, 0) / (withOT.length || 1),
    actualOT: withOT.filter((r) => r.result.endedIn !== "REG").length / (withOT.length || 1),
    predictedTotal: withTotal.reduce((a, r) => a + r.expTotal, 0) / (withTotal.length || 1),
    actualTotal: withTotal.reduce((a, r) => a + r.result.home + r.result.away, 0) / (withTotal.length || 1),
  };

  // Favorites: how often the model's pick won, by confidence
  const strong = done.filter((r) => Math.max(r.pHome, 1 - r.pHome) >= 0.6);
  const strongWins = strong.filter((r) => (r.pHome >= 0.5) === (homeWon(r) === 1)).length;

  return {
    n: done.length,
    homeWinRate: ys.reduce((a, b) => a + b, 0) / ys.length,
    model: forecastScores(model, ys),
    base: forecastScores(base, ys),
    constant: forecastScores(constant, ys),
    skillVsConstant: skill(model, constant, ys),
    skillVsBase: skill(model, base, ys),
    baseSkillVsConstant: skill(base, constant, ys),
    calibration: calibrationBins(model, ys, bins),
    months,
    shape,
    confident: { n: strong.length, wins: strongWins },
  };
}
