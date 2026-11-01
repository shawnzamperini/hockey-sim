// Scorecard view: how well the model's pre-game probabilities hold up.
// Two datasets, scored by the same code (scoring.js):
//   - live: this season's log, predictions frozen at puck drop
//   - backtest: last season, each game predicted from the day-before standings

import { scoreRecords, homeWon, HOME_RATE } from "./scoring.js";
import { americanOdds } from "./lines.js";

const odds = (p) => { const o = americanOdds(p); return o === null ? "–" : o > 0 ? `+${o}` : `−${Math.abs(o)}`; };

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
})[c]);
const pct = (x, d = 1) => `${(100 * x).toFixed(d)}%`;
const signedPct = (x, d = 1) => `${x >= 0 ? "+" : "−"}${(100 * Math.abs(x)).toFixed(d)}%`;
const monthName = (ym) => new Date(`${ym}-15T12:00:00`).toLocaleDateString([], { month: "short" });

// ------------------------------------------------------------------ text

/** Is a skill clearly above zero, clearly below, or within noise (2 SE)? */
function verdict({ skill, se }) {
  if (skill - 2 * se > 0) return "better";
  if (skill + 2 * se < 0) return "worse";
  return "noise";
}

function verdictText(x) {
  return { better: "clearly better", worse: "clearly worse", noise: "within noise" }[verdict(x)];
}

function summary(s, label, live) {
  const vsHome = s.skillVsConstant, vsBase = s.skillVsBase;
  const homeText = {
    better: `${pct(vsHome.skill)} more accurate than always giving the home team 54%`,
    worse: `${pct(-vsHome.skill)} less accurate than always giving the home team 54%`,
    noise: `about as accurate as always giving the home team 54% (the difference is within noise)`,
  }[verdict(vsHome)];
  const baseText = {
    better: `and ${pct(vsBase.skill)} more accurate than a standings-only model`,
    worse: `but ${pct(Math.abs(vsBase.skill))} less accurate than a standings-only model`,
    noise: `and level with a standings-only model${live ? " so far" : ""}`,
  }[verdict(vsBase)];
  return `Across ${s.n.toLocaleString()} ${label}, the model's favorite won ${pct(s.model.accuracy)} of the time. ` +
    `Its probabilities were ${homeText}, ${baseText}.`;
}

function tile(label, value, note) {
  return `<div class="tile"><div class="tile-label">${esc(label)}</div>
    <div class="tile-value">${value}</div><div class="tile-note">${note}</div></div>`;
}

// ------------------------------------------------------------------ charts

/**
 * Calibration chart: predicted vs actual home-win rate, one dot per group of
 * games with similar predictions, ±2 SE whiskers, diagonal = perfect.
 */
function calibrationChart(bins) {
  const W = 340, H = 300, L = 42, R = 14, T = 14, B = 40;
  const lo0 = Math.min(...bins.map((b) => Math.min(b.predicted, b.observed - 2 * b.se)));
  const hi0 = Math.max(...bins.map((b) => Math.max(b.predicted, b.observed + 2 * b.se)));
  const lo = Math.max(0, Math.floor(lo0 * 10) / 10), hi = Math.min(1, Math.ceil(hi0 * 10) / 10);
  const x = (v) => L + ((v - lo) / (hi - lo)) * (W - L - R);
  const y = (v) => H - B - ((v - lo) / (hi - lo)) * (H - T - B);
  const ticks = [];
  for (let v = lo; v <= hi + 1e-9; v += 0.1) ticks.push(Number(v.toFixed(2)));

  const grid = ticks.map((v) => `
      <line class="grid" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/>
      <text class="tick" x="${L - 6}" y="${y(v) + 4}" text-anchor="end">${Math.round(v * 100)}%</text>
      <text class="tick" x="${x(v)}" y="${H - B + 16}" text-anchor="middle">${Math.round(v * 100)}%</text>`).join("");
  const dots = bins.map((b, i) => `
      <g class="cal-point" data-i="${i}" tabindex="0" role="button"
         aria-label="${esc(`Predicted ${pct(b.predicted, 0)}, home team won ${pct(b.observed, 0)} of ${b.n} games`)}">
        <line class="whisker" x1="${x(b.predicted)}" x2="${x(b.predicted)}"
              y1="${y(Math.max(lo, b.observed - 2 * b.se))}" y2="${y(Math.min(hi, b.observed + 2 * b.se))}"/>
        <circle class="dot" cx="${x(b.predicted)}" cy="${y(b.observed)}" r="5"/>
        <circle class="hit" cx="${x(b.predicted)}" cy="${y(b.observed)}" r="16"/>
      </g>`).join("");
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img"
      aria-label="Calibration chart: predicted versus actual home win rate">
      ${grid}
      <line class="diag" x1="${x(lo)}" y1="${y(lo)}" x2="${x(hi)}" y2="${y(hi)}"/>
      <text class="diag-label" x="${x(hi) - 4}" y="${y(hi) + 16}" text-anchor="end">Perfect calibration</text>
      ${dots}
      <text class="axis-title" x="${(L + W - R) / 2}" y="${H - 4}" text-anchor="middle">Model's chance the home team wins</text>
    </svg>`;
}

/** Horizontal bars of skill vs the home-ice guess, with ±2 SE whiskers. */
function skillBars(s) {
  const rows = [
    { label: "Home 54%", value: 0, se: 0, cls: "ref", note: "reference" },
    { label: "Standings only", value: s.baseSkillVsConstant.skill, se: s.baseSkillVsConstant.se, cls: "muted" },
    { label: "This model", value: s.skillVsConstant.skill, se: s.skillVsConstant.se, cls: "model" },
  ];
  const lo = Math.min(0, ...rows.map((r) => r.value - 2 * r.se));
  const hi = Math.max(0.01, ...rows.map((r) => r.value + 2 * r.se));
  const pos = (v) => (100 * (v - lo)) / (hi - lo);
  const zero = pos(0);
  return `<div class="bars" role="list">${rows.map((r) => {
    const a = pos(Math.min(0, r.value)), b = pos(Math.max(0, r.value));
    const whisker = r.se ? `<span class="bar-whisker" style="left:${pos(r.value - 2 * r.se)}%;width:${pos(r.value + 2 * r.se) - pos(r.value - 2 * r.se)}%"></span>` : "";
    return `<div class="bar-row" role="listitem">
        <span class="bar-label">${esc(r.label)}</span>
        <span class="bar-track">
          <span class="bar-zero" style="left:${zero}%"></span>
          ${r.value ? `<span class="bar-fill ${r.cls} ${r.value < 0 ? "neg" : ""}" style="left:${a}%;width:${b - a}%"></span>` : ""}
          ${whisker}
        </span>
        <span class="bar-value">${r.note ? esc(r.note) : signedPct(r.value)}</span>
      </div>`;
  }).join("")}</div>`;
}

/** Monthly skill columns vs the home-ice guess. */
function monthChart(months) {
  const W = 340, H = 190, L = 40, R = 8, T = 18, B = 40;
  const vals = months.map((m) => m.skill);
  const hi = Math.max(0.01, ...vals) * 1.15;
  // Leave room under negative bars for their labels, clear of the month names.
  const lo = Math.min(0, ...vals) < 0 ? Math.min(0, ...vals) * 1.15 - 0.18 * hi : 0;
  const y = (v) => T + ((hi - v) / (hi - lo)) * (H - T - B);
  const band = (W - L - R) / months.length;
  const bw = Math.min(24, band * 0.6);
  const step = (hi - lo) > 0.12 ? 0.05 : (hi - lo) > 0.05 ? 0.02 : 0.01;
  const ticks = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) ticks.push(Number(v.toFixed(3)));
  const r = 4;
  const bars = months.map((m, i) => {
    const cx = L + band * (i + 0.5), x0 = cx - bw / 2;
    const y0 = y(0), y1 = y(m.skill);
    const h = Math.abs(y1 - y0);
    let path = "";
    if (h > 0.5) {
      const rr = Math.min(r, h, bw / 2);
      path = m.skill >= 0
        ? `M${x0},${y0} V${y1 + rr} Q${x0},${y1} ${x0 + rr},${y1} H${x0 + bw - rr} Q${x0 + bw},${y1} ${x0 + bw},${y1 + rr} V${y0} Z`
        : `M${x0},${y0} V${y1 - rr} Q${x0},${y1} ${x0 + rr},${y1} H${x0 + bw - rr} Q${x0 + bw},${y1} ${x0 + bw},${y1 - rr} V${y0} Z`;
    }
    const labelY = m.skill >= 0 ? y1 - 5 : y1 + 13;
    return `<g class="month" tabindex="0" aria-label="${esc(`${monthName(m.month)}: ${signedPct(m.skill)} versus home-ice guess, ${m.n} games`)}">
        ${path ? `<path class="col" d="${path}"/>` : ""}
        <text class="col-label" x="${cx}" y="${labelY}" text-anchor="middle">${Math.round(100 * m.skill) === 0 ? "0%" : signedPct(m.skill, 0)}</text>
        <text class="tick" x="${cx}" y="${H - B + 16}" text-anchor="middle">${monthName(m.month)}</text>
        <text class="tick faint" x="${cx}" y="${H - B + 30}" text-anchor="middle">${m.n}</text>
      </g>`;
  }).join("");
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Skill by month">
      ${ticks.map((v) => `<line class="grid${v === 0 ? " zero" : ""}" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/>
        <text class="tick" x="${L - 6}" y="${y(v) + 4}" text-anchor="end">${Math.abs(v) < 1e-9 ? "0%" : signedPct(v, 0)}</text>`).join("")}
      ${bars}
    </svg>`;
}

// ------------------------------------------------------------------ sections

function comparisonTable(s) {
  const row = (name, f, cls = "") => `<tr class="${cls}"><th scope="row">${name}</th>
      <td>${f.brier.toFixed(4)}</td><td>${f.logLoss.toFixed(4)}</td><td>${pct(f.accuracy)}</td></tr>`;
  return `<table class="num-table">
      <thead><tr><th></th><th>Brier</th><th>Log loss</th><th>Pick won</th></tr></thead>
      <tbody>${row("This model", s.model, "is-model")}${row("Standings only", s.base)}${row("Home 54%", s.constant)}</tbody>
    </table>`;
}

function calibrationTable(bins) {
  return `<table class="num-table">
      <thead><tr><th>Predicted</th><th>Home won</th><th>Games</th></tr></thead>
      <tbody>${bins.map((b) => `<tr><td>${pct(b.predicted)}</td><td>${pct(b.observed)} ± ${pct(2 * b.se)}</td><td>${b.n}</td></tr>`).join("")}</tbody>
    </table>`;
}

function shapeRows(sh) {
  return `<table class="num-table shape">
      <thead><tr><th></th><th>Predicted</th><th>Actual</th></tr></thead>
      <tbody>
        <tr><th scope="row">Games to overtime</th><td>${pct(sh.predictedOT)}</td><td>${pct(sh.actualOT)}</td></tr>
        <tr><th scope="row">Goals per game</th><td>${sh.predictedTotal.toFixed(2)}</td><td>${sh.actualTotal.toFixed(2)}</td></tr>
      </tbody>
    </table>`;
}

function recentPicks(records) {
  const done = records.filter((r) => r.result).slice(-15).reverse();
  if (!done.length) return "";
  return `<h3 class="res-heading">Recent picks</h3>
    <ol class="picks">${done.map((r) => {
      const favHome = r.pHome >= 0.5;
      const fav = favHome ? r.home : r.away, p = favHome ? r.pHome : 1 - r.pHome;
      const right = favHome === (homeWon(r) === 1);
      const date = new Date(`${r.date}T12:00:00`).toLocaleDateString([], { month: "short", day: "numeric" });
      const ot = r.result.endedIn !== "REG" ? ` ${r.result.endedIn}` : "";
      return `<li>
          <span class="pick-match">${esc(r.away)} at ${esc(r.home)}<small>${date}</small></span>
          <span class="pick-call">${esc(fav)} ${pct(p, 0)}<small class="odds">${odds(p)}</small></span>
          <span class="pick-result ${right ? "right" : "wrong"}">${r.result.away}–${r.result.home}${ot}<small>${right ? "Pick won" : "Pick lost"}</small></span>
        </li>`;
    }).join("")}</ol>`;
}

function scoredView(s, records, { label, live }) {
  const home = s.skillVsConstant, base = s.skillVsBase;
  // Is the start of the season harder? Compare the first two months with the rest.
  const firstTwo = s.months.slice(0, 2), rest = s.months.slice(2);
  const avg = (ms) => ms.reduce((a, m) => a + m.skill * m.n, 0) / (ms.reduce((a, m) => a + m.n, 0) || 1);
  const earlyHarder = rest.length >= 2 && avg(firstTwo) < avg(rest);
  return `
    <p class="lede">${esc(summary(s, label, live))}</p>
    <div class="tiles">
      ${tile("Favorite won", pct(s.model.accuracy), `${s.n.toLocaleString()} games; the home team won ${pct(s.homeWinRate, 0)}`)}
      ${tile("Better than home-ice guess", signedPct(home.skill), `± ${pct(2 * home.se)}; ${verdictText(home)}`)}
      ${tile("Better than standings", signedPct(base.skill), `± ${pct(2 * base.se)}; ${verdictText(base)}`)}
      ${tile("Brier score", s.model.brier.toFixed(4), "0.2500 is a coin flip; lower is better")}
    </div>

    <h3 class="res-heading">Can the percentages be trusted?</h3>
    <p class="explain">Each dot groups about ${Math.round(s.n / s.calibration.length).toLocaleString()} games with similar
      predictions. If the model says 60%, the home team should win about 60% of those games, so dots near the line
      mean the numbers can be taken at face value. Whiskers show the range expected from luck alone.</p>
    ${calibrationChart(s.calibration)}
    <p class="readout" aria-live="polite">Tap a dot for its numbers.</p>
    <details class="numbers"><summary>Show the numbers</summary>${calibrationTable(s.calibration)}</details>

    <h3 class="res-heading">Compared with simpler models</h3>
    <p class="explain">How much of the error of always giving the home team 54% each approach removes. The standings-only
      model rates teams by points percentage. Whiskers show the range expected from luck alone; hockey is close to a coin
      flip, so a few percent is a real edge.</p>
    ${skillBars(s)}
    <details class="numbers"><summary>Show the numbers</summary>${comparisonTable(s)}</details>

    ${s.months.length > 1 ? `
    <h3 class="res-heading">By month</h3>
    <p class="explain">Improvement over the home-ice guess for games in each month (game counts underneath).
      ${earlyHarder ? "The first two months are harder than the rest: a few weeks of standings say little about how good a team is." : ""}</p>
    ${monthChart(s.months)}` : ""}

    <h3 class="res-heading">Does the game shape look right?</h3>
    <p class="explain">Averages over all games. These check the calibrated league settings rather than who wins.</p>
    ${shapeRows(s.shape)}

    ${live ? recentPicks(records) : ""}`;
}

// ------------------------------------------------------------------ main

export function renderScorecard(el, { live, backtest, which }) {
  const liveRecords = live?.records || [];
  const btRecords = backtest?.records || [];
  const liveScore = scoreRecords(liveRecords);
  const btScore = scoreRecords(btRecords);
  const pending = liveRecords.filter((r) => !r.result).length;
  const seasonLabel = (id) => (id ? `${String(id).slice(0, 4)}–${String(id).slice(6)}` : "");

  const tabs = `<div class="segmented" role="tablist">
      <button role="tab" data-which="live" aria-selected="${which === "live"}">This season</button>
      <button role="tab" data-which="backtest" aria-selected="${which === "backtest"}">Last season</button>
    </div>`;

  let body;
  if (which === "live") {
    body = liveScore
      ? scoredView(liveScore, liveRecords, { label: "games this season", live: true }) +
        (pending ? `<p class="sim-note">${pending} more ${pending === 1 ? "prediction is" : "predictions are"} waiting on results.</p>` : "")
      : `<p class="empty">No games scored yet. Each game is predicted before puck drop and scored once it ends.
          ${pending ? `${pending} ${pending === 1 ? "prediction is" : "predictions are"} waiting on results.` : "The first predictions are made within a day of each game."}
          Meanwhile, the last-season backtest shows how the model has done over a full season.</p>`;
  } else {
    body = btScore
      ? `<p class="context">Every game of ${seasonLabel(backtest.season)}, each predicted using only the standings from the
          day before, the way the model would have seen it at the time.</p>` +
        scoredView(btScore, btRecords, { label: "games last season", live: false })
      : `<p class="empty">The backtest hasn't run yet. It runs with the weekly calibration and replays last season
          game by game.</p>`;
  }

  const stamp = which === "live"
    ? (live?.updatedAt ? `Log updated ${new Date(live.updatedAt).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}.` : "")
    : (backtest?.generatedAt ? `Backtest run ${new Date(backtest.generatedAt).toLocaleDateString([], { month: "short", day: "numeric" })} with the current model.` : "");

  el.innerHTML = `${tabs}<div class="scorecard-body">${body}</div>${stamp ? `<p class="sim-note">${stamp}</p>` : ""}`;

  // Tap or hover a calibration dot to read its numbers.
  const score = which === "live" ? liveScore : btScore;
  const readout = el.querySelector(".readout");
  el.querySelectorAll(".cal-point").forEach((g) => {
    const show = () => {
      const b = score.calibration[Number(g.dataset.i)];
      el.querySelectorAll(".cal-point.is-active").forEach((n) => n.classList.remove("is-active"));
      g.classList.add("is-active");
      readout.textContent = `Predicted ${pct(b.predicted)} on average; the home team won ${pct(b.observed)} of ${b.n} games (±${pct(2 * b.se)} from luck).`;
    };
    g.addEventListener("click", show);
    g.addEventListener("mouseenter", show);
    g.addEventListener("focus", show);
  });
}

export { HOME_RATE };
