import { teamColor } from "./teams.js";
import { renderScorecard } from "./scorecard.js";
import { buildSchedule, gameContext } from "./sim/schedule.js";
import { parseOdds, expectedValue, fairOdds, totalLine, spreadLine, defaultTotal, americanOdds } from "./lines.js";
import * as account from "./account.js";
import { DATA_URL as DATA_BASE } from "./config.js";
import { initBets, showBets, noteNewBet } from "./betsview.js";

// Public data comes from storage; the model (goalies, lineups, simulations)
// from the signed-in model API (account.callModel), never the page itself.
const DATA_URL = `${DATA_BASE}/games.json`;
const REFRESH_AFTER_MS = 10 * 60 * 1000;   // re-check data when reopened after 10 min

const els = {
  title: document.getElementById("day-title"),
  sub: document.getElementById("day-sub"),
  strip: document.getElementById("day-strip"),
  content: document.getElementById("content"),
  updated: document.getElementById("updated"),
  sheet: document.getElementById("sheet"),
  sheetBody: document.getElementById("sheet-body"),
};

const state = {
  data: null,
  selected: null,     // "YYYY-MM-DD"
  loadedAt: 0,
  details: new Map(),   // game id + lineup picks -> Promise of the model API's details
};

const darkMode = window.matchMedia("(prefers-color-scheme: dark)");

// ------------------------------------------------------------------ dates

function localISODate(d = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function parseISODate(s) {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function fmtTime(iso) {
  if (!iso) return "TBD";
  return new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function dayHeading(dateStr) {
  const today = localISODate();
  const d = parseISODate(dateStr);
  const offset = Math.round((d - parseISODate(today)) / 86400000);
  if (offset === 0) return "Today";
  if (offset === -1) return "Yesterday";
  if (offset === 1) return "Tomorrow";
  return d.toLocaleDateString([], { weekday: "long" });
}

// ------------------------------------------------------------------ helpers

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}

function logoHTML(team) {
  const src = darkMode.matches ? (team.darkLogo || team.logo) : team.logo;
  const fallback = `<span class="logo-fallback" style="background:${teamColor(team.abbrev)}">${esc(team.abbrev)}</span>`;
  if (!src) return fallback;
  return `<img class="logo" src="${esc(src)}" alt="" loading="lazy" data-abbrev="${esc(team.abbrev)}">`;
}

// Swap broken logo images for a colored badge.
document.addEventListener("error", (e) => {
  const img = e.target;
  if (!(img instanceof HTMLImageElement) || !img.classList.contains("logo")) return;
  const span = document.createElement("span");
  span.className = "logo-fallback";
  span.style.background = teamColor(img.dataset.abbrev);
  span.textContent = img.dataset.abbrev || "?";
  img.replaceWith(span);
}, true);

function record(abbrev) {
  const t = state.data?.teams?.[abbrev];
  return t ? `${t.w}-${t.l}-${t.otl}` : "";
}

function isFinal(g) { return g.state === "OFF" || g.state === "FINAL"; }
function isLive(g) { return g.state === "LIVE" || g.state === "CRIT"; }

function finalLabel(g) {
  return g.endedIn === "OT" ? "Final/OT" : g.endedIn === "SO" ? "Final/SO" : "Final";
}

function statusHTML(g) {
  if (g.schedule === "PPD") return "Postponed";
  if (g.schedule === "CNCL") return "Canceled";
  if (isFinal(g)) return `<span class="final">${finalLabel(g)}</span>`;
  if (isLive(g)) return `<span class="live">Live</span>`;
  return esc(fmtTime(g.start));
}

// ------------------------------------------------------------------ rendering

function renderStrip() {
  const today = localISODate();
  els.strip.innerHTML = state.data.days.map(({ date, games }) => {
    const d = parseISODate(date);
    const classes = ["day-btn"];
    if (date === today) classes.push("is-today");
    if (!games.length) classes.push("no-games");
    const current = date === state.selected ? ' aria-current="date"' : "";
    const label = `${d.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" })}, ${games.length} games`;
    return `<button class="${classes.join(" ")}" data-date="${date}"${current} aria-label="${esc(label)}">
        <span class="wd">${d.toLocaleDateString([], { weekday: "short" })}</span>
        <span class="dn">${d.getDate()}</span>
        <span class="dot" aria-hidden="true"></span>
      </button>`;
  }).join("");

  const active = els.strip.querySelector('[aria-current="date"]');
  active?.scrollIntoView({ inline: "center", block: "nearest" });
}

function teamLineHTML(g, side) {
  const team = g[side];
  const other = g[side === "away" ? "home" : "away"];
  const lost = isFinal(g) && team.score != null && other.score != null && team.score < other.score;
  const showScore = (isFinal(g) || isLive(g)) && team.score != null;
  return `<div class="team-line${lost ? " lost" : ""}">
      ${logoHTML(team)}
      <span class="team-name">${esc(team.short)}<span class="team-rec">${esc(record(team.abbrev))}</span></span>
      <span class="score">${showScore ? team.score : ""}</span>
    </div>`;
}

function renderGames() {
  const day = state.data.days.find((d) => d.date === state.selected);
  const date = parseISODate(state.selected);
  els.title.textContent = dayHeading(state.selected);
  const n = day?.games.length ?? 0;
  els.sub.textContent = `${date.toLocaleDateString([], { month: "long", day: "numeric" })}, ${n === 1 ? "1 game" : `${n} games`}`;

  if (!n) {
    els.content.innerHTML = `<p class="status-msg">No NHL games on this day. Pick another day above.</p>`;
    return;
  }

  els.content.innerHTML = `<ul class="games">${day.games.map((g, i) => `
      <li>
        <button class="game${isFinal(g) ? " is-final" : ""}" data-index="${i}"
          aria-label="${esc(`${g.away.name} at ${g.home.name}`)}">
          <span class="game-status">${statusHTML(g)}</span>
          <span class="teams">${teamLineHTML(g, "away")}${teamLineHTML(g, "home")}</span>
        </button>
      </li>`).join("")}</ul>`;
}

function renderUpdated() {
  if (!state.data?.updated) { els.updated.textContent = ""; return; }
  const u = new Date(state.data.updated);
  const sameDay = localISODate(u) === localISODate();
  const when = sameDay
    ? u.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    : u.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  els.updated.textContent = `Schedule and scores updated ${when}. Refreshes hourly.`;
}

function render() {
  renderStrip();
  renderGames();
  renderUpdated();
}

// ------------------------------------------------------------------ detail sheet

function compareRow(label, a, b, { higherIsBetter = true, digits = 0, bar = true, text = false, flag = null } = {}) {
  const numeric = typeof a === "number" && typeof b === "number";
  let edgeA = false, edgeB = false;
  if (numeric && a !== b) {
    const aBetter = higherIsBetter ? a > b : a < b;
    edgeA = aBetter; edgeB = !aBetter;
  }
  const max = numeric ? Math.max(a, b, 1e-9) : 1;
  const cell = (v, side, edge) => {
    const shown = numeric ? v.toFixed(digits) : esc(v || "–");
    const barHTML = numeric && bar ? `<div class="bar"><span style="width:${(100 * v / max).toFixed(1)}%"></span></div>` : "";
    const flagged = flag && flag(v) ? " flagged" : "";
    return `<div class="val ${side}${edge ? " edge" : ""}${text ? " text" : ""}${flagged}">${shown}${barHTML}</div>`;
  };
  return `<div class="compare-row">${cell(a, "away", edgeA)}<div class="label">${esc(label)}</div>${cell(b, "home", edgeB)}</div>`;
}

// Model stats (members): xG per game, and power-play and penalty-kill scoring
// per 60 minutes of man-advantage time and penalties per game, from the
// recency-weighted history the model uses.
function modelStatsHTML(d) {
  const a = d.sides.away, h = d.sides.home;
  const rows = [];
  if (a.xg && h.xg) {
    rows.push(compareRow("xG for per game", a.xg.for, h.xg.for, { digits: 2 }));
    rows.push(compareRow("xG against per game", a.xg.against, h.xg.against, { digits: 2, higherIsBetter: false }));
  }
  if (a.st && h.st) {
    rows.push(compareRow("Power play goals / 60", a.st.pp60, h.st.pp60, { digits: 1 }));
    rows.push(compareRow("Penalty kill goals against / 60", a.st.pk60, h.st.pk60, { digits: 1, higherIsBetter: false }));
    rows.push(compareRow("Penalties taken per game", a.st.pens, h.st.pens, { digits: 1, higherIsBetter: false }));
    rows.push(compareRow("Penalties drawn per game", a.st.drawn, h.st.drawn, { digits: 1 }));
  }
  return rows.length ? `<div class="compare model-stats">${rows.join("")}</div>` : "";
}

function compareHTML(g) {
  const a = state.data.teams?.[g.away.abbrev];
  const h = state.data.teams?.[g.home.abbrev];
  if (!a || !h) return `<p class="sim-note">Team stats will appear once standings are available.</p>`;
  const perGame = (t, k) => (t.gp ? t[k] / t.gp : 0);
  return `<div class="compare">
      ${compareRow("Record", record(g.away.abbrev), record(g.home.abbrev), { bar: false })}
      ${compareRow("Points", a.pts, h.pts)}
      ${compareRow("Goals for per game", perGame(a, "gf"), perGame(h, "gf"), { digits: 2 })}
      ${compareRow("Goals against per game", perGame(a, "ga"), perGame(h, "ga"), { digits: 2, higherIsBetter: false })}
      ${compareRow("Last 10", a.l10, h.l10, { bar: false })}
      ${compareRow("Streak", a.streak, h.streak, { bar: false })}
      ${isFinal(g) || isLive(g) ? "" : restRow(g)}
    </div>`;
}

// Rest going into a game, from the schedule in the data window (which starts
// yesterday, so back-to-backs are always visible).
function contextFor(g, date) {
  state.schedule ||= buildSchedule((state.data?.days || []).flatMap((d) => d.games
    .filter((x) => x.schedule !== "PPD" && x.schedule !== "CNCL")
    .map((x) => ({ date: d.date, home: x.home.abbrev, away: x.away.abbrev }))));
  return gameContext(state.schedule, { date, home: g.home.abbrev, away: g.away.abbrev });
}

function restText(c, firstDate, date) {
  if (c.b2b) return "Back-to-back";
  // restDays is exact only if the team's previous game is inside the window.
  const known = date > firstDate && c.restDays < 3;
  if (!known) return "Rested";
  return c.restDays === 1 ? "1 day off" : `${c.restDays} days off`;
}

function restRow(g) {
  const date = state.selected, first = state.data?.days?.[0]?.date;
  const c = contextFor(g, date);
  return compareRow("Rest", restText(c.away, first, date), restText(c.home, first, date),
    { bar: false, text: true, flag: (v) => v === "Back-to-back" });
}

// ------------------------------------------------------------------ goalie picks

// Your starting-goalie picks, per game, saved on this device.
function loadPicks() {
  try { return JSON.parse(localStorage.getItem("goaliePicks") || "{}"); } catch { return {}; }
}
function savePicks(all) {
  try { localStorage.setItem("goaliePicks", JSON.stringify(all)); } catch { /* storage unavailable */ }
}
function picksFor(gameId) {
  return loadPicks()[gameId] || {};
}
function setPick(gameId, side, goalieId) {
  const all = loadPicks();
  const cur = { ...(all[gameId] || {}) };
  if (goalieId) cur[side] = goalieId; else delete cur[side];
  if (Object.keys(cur).length) all[gameId] = cur; else delete all[gameId];
  // Forget picks for games more than a few days old.
  const keep = new Set((state.data?.days || []).flatMap((d) => d.games.map((x) => String(x.id))));
  for (const k of Object.keys(all)) if (!keep.has(k)) delete all[k];
  savePicks(all);
}

const signed = (x) => `${x >= 0 ? "+" : "−"}${Math.abs(x).toFixed(1)}`;

function goalieSectionHTML(g, d) {
  if (isFinal(g) || isLive(g) || !d) return "";
  const picks = picksFor(String(g.id));
  const rows = ["away", "home"].map((side) => {
    const list = d.sides[side].goalies || [];
    if (!list.length) return "";
    const proj = [...list].filter((o) => o.p > 0).sort((x, y) => y.p - x.p);
    const projText = proj.slice(0, 2).map((o) => `${o.name.split(" ").slice(-1)[0]} ${Math.round(100 * o.p)}%`).join(", ");
    const options = list.map((x) => {
      const bits = [`${Math.round(100 * x.p)}% to start`];
      if (x.starts) bits.push(`${signed(x.gsax || 0)} GSAx`);
      return `<option value="${esc(x.id)}" ${picks[side] === String(x.id) ? "selected" : ""}>${esc(x.name)} (${bits.join(", ")})</option>`;
    }).join("");
    return `<label class="goalie-pick">
        <span class="goalie-team">${esc(g[side].abbrev)}</span>
        <select data-goalie-side="${side}" aria-label="${esc(`${g[side].short} starting goalie`)}">
          <option value="" ${picks[side] ? "" : "selected"}>Projected: ${esc(projText)}</option>
          ${options}
        </select>
      </label>`;
  }).join("");
  if (!rows) return "";
  return `<section class="goalies">
      <h3 class="res-heading">Starting goalies</h3>
      <p class="explain">Projected from recent starts; each simulated game draws its starter with these odds.
        Pick a goalie to lock him in. GSAx is goals saved above expected this season.</p>
      ${rows}
    </section>`;
}

// ------------------------------------------------------------------ lineup picks

// Your lineup changes, per game: { side: { out: [ids], add: [ids] } }, saved
// on this device.
function loadLineups() {
  try { return JSON.parse(localStorage.getItem("lineupPicks") || "{}"); } catch { return {}; }
}
function lineupFor(gameId, side) {
  const x = loadLineups()[gameId]?.[side] || {};
  return { out: (x.out || []).map(String), add: (x.add || []).map(String) };
}
function toggleLineup(gameId, side, playerId, wasLast) {
  const all = loadLineups();
  const game = { ...(all[gameId] || {}) };
  const cur = lineupFor(gameId, side);
  const id = String(playerId);
  const flip = (list) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);
  if (wasLast) cur.out = flip(cur.out); else cur.add = flip(cur.add);
  if (cur.out.length || cur.add.length) game[side] = cur; else delete game[side];
  if (Object.keys(game).length) all[gameId] = game; else delete all[gameId];
  const keep = new Set((state.data?.days || []).flatMap((d) => d.games.map((x) => String(x.id))));
  for (const k of Object.keys(all)) if (!keep.has(k)) delete all[k];
  try { localStorage.setItem("lineupPicks", JSON.stringify(all)); } catch { /* storage unavailable */ }
}

const mmss = (sec) => `${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, "0")}`;
const goals = (x) => `${x >= 0 ? "+" : "−"}${Math.abs(x).toFixed(2)}`;

function lineupTeamHTML(g, side, open, d) {
  const view = d?.sides[side].lineup;
  if (!view?.players?.length) return "";
  const pick = lineupFor(String(g.id), side);
  const value = (p) => p.value.total;
  const split = (p) => {
    const v = p.value, b = [`5v5 ${signed(82 * v.ev)}`];
    if (view.specialTeams) b.push(`PP/PK ${signed(82 * v.st)}`);
    if (Math.abs(82 * v.fin) >= 0.05) b.push(`finish ${signed(82 * v.fin)}`);
    return b.join(" · ");
  };
  const row = (p) => {
    const id = String(p.id);
    const dressed = p.last ? !pick.out.includes(id) : pick.add.includes(id);
    const changed = p.last ? !dressed : dressed;
    return `<li><button type="button" class="lineup-player${dressed ? "" : " is-out"}${changed ? " is-changed" : ""}"
        data-lineup-side="${side}" data-player="${esc(id)}" data-last="${p.last ? 1 : 0}" aria-pressed="${dressed}">
        <span class="lp-name">${esc(p.name)}<small class="lp-split">${esc(split(p))}</small></span>
        <span class="lp-pos">${esc(p.pos)}</span>
        <span class="lp-toi">${mmss(p.toi)}</span>
        <span class="lp-val">${signed(82 * value(p))}</span>
        <span class="lp-state">${dressed ? "In" : "Out"}</span>
      </button></li>`;
  };
  const byValue = (a, b) => value(b) - value(a);
  const regulars = view.players.filter((p) => p.last).sort(byValue);
  const others = view.players.filter((p) => !p.last).sort(byValue);
  const changes = [...view.out.map((n) => `${n} out`), ...view.add.map((n) => `${n} in`)];
  const net = view.net;
  return `<details class="lineup" data-lineup="${side}"${open ? " open" : ""}>
      <summary>
        <span class="goalie-team">${esc(g[side].abbrev)}</span>
        <span class="lineup-sum">${esc(changes.length ? changes.join(", ") : "Last game's lineup")}</span>
        <span class="lineup-net${Math.abs(net) >= 0.005 ? (net > 0 ? " up" : " down") : ""}">${goals(net)}</span>
      </summary>
      <ul class="lineup-list">
        <li class="lineup-head"><span>Dressed last game</span><span></span><span>5v5 TOI</span><span>Per 82</span><span></span></li>
        ${regulars.map(row).join("")}
        ${others.length ? `<li class="lineup-head"><span>Also played recently · tap to add</span></li>${others.map(row).join("")}` : ""}
      </ul>
    </details>`;
}

function lineupSectionHTML(g, openSides = [], d) {
  if (isFinal(g) || isLive(g) || !d) return "";
  const rows = ["away", "home"].map((side) => lineupTeamHTML(g, side, openSides.includes(side), d)).join("");
  if (!rows) return "";
  return `<section class="lineups">
      <h3 class="res-heading">Lineups</h3>
      <p class="explain">Each team starts from the skaters who dressed in its last game. Tap a player to scratch him
        and a replacement-level skater (a call-up) takes his minutes, or tap a recent player to dress him.
        "Per 82" is a skater's goals above replacement over a full season at his usual ice time:
        5-on-5 play, power play and penalty kill, and finishing (scoring more than his shots' expected goals).
        The number beside each team is tonight's change in expected goal difference per game, compared with
        the lineups behind its rating.</p>
      ${rows}
    </section>`;
}

async function refreshLineups(g) {
  const sec = els.sheetBody.querySelector(".lineups");
  if (!sec) return;
  const open = [...sec.querySelectorAll("details[open]")].map((d) => d.dataset.lineup);
  sec.classList.add("is-updating");
  try {
    const d = await detailsFor(g);
    const now = els.sheetBody.querySelector(".lineups");
    if (now && state.sheetGame?.id === g.id) now.outerHTML = lineupSectionHTML(g, open, d);
  } catch (err) {
    sec.classList.remove("is-updating");
  }
}

// ------------------------------------------------------------------ model details

const lineupPicks = (g) => ({ away: lineupFor(String(g.id), "away"), home: lineupFor(String(g.id), "home") });

/** The model API's details for a game with the current lineup picks (cached). */
function detailsFor(g) {
  const picks = lineupPicks(g);
  const key = `${g.id}|${JSON.stringify(picks)}`;
  if (!state.details.has(key)) {
    const p = account.callModel({ action: "details", gameId: g.id, lineup: picks });
    p.catch(() => state.details.delete(key));
    state.details.set(key, p);
  }
  return state.details.get(key);
}

/** Fill the model part of the sheet: stats, goalies and lineups (members only). */
async function loadModelDetails(g) {
  const box = els.sheetBody.querySelector("#model-details");
  if (!box || !account.configured()) return;
  if (isFinal(g) || isLive(g)) { box.innerHTML = ""; return; }
  const user = mayBeSignedIn() ? await account.currentUser().catch(() => null) : null;
  if (!user) {
    box.innerHTML = `<p class="sim-note gate-note">Projected goalies, lineups, model stats and simulations are for
      members. <button type="button" class="link-btn" data-goto="bets">Sign in on the Bets tab</button>.</p>`;
    return;
  }
  box.innerHTML = `<p class="sim-note">Loading the model…</p>`;
  try {
    const d = await detailsFor(g);
    if (state.sheetGame?.id !== g.id) return;
    box.innerHTML = `${modelStatsHTML(d)}${goalieSectionHTML(g, d)}${lineupSectionHTML(g, [], d)}`;
  } catch (err) {
    if (state.sheetGame?.id !== g.id) return;
    box.innerHTML = `<p class="sim-note">The model didn't load: ${esc(err.message)}
      <button type="button" class="link-btn" data-reload-details>Try again</button></p>`;
  }
}

function simKey(g) {
  const p = picksFor(String(g.id));
  const l = (side) => { const x = lineupFor(String(g.id), side); return `${[...x.out].sort()}/${[...x.add].sort()}`; };
  return `${g.id}|${p.home || ""}|${p.away || ""}|${l("home")}|${l("away")}`;
}

function openSheet(g) {
  const middle = isFinal(g) || isLive(g)
    ? `<div class="vs scoreline">${g.away.score ?? 0}–${g.home.score ?? 0}</div>`
    : `<div class="vs">at</div>`;
  const date = new Date(g.start);
  const when = isFinal(g)
    ? finalLabel(g)
    : isLive(g) ? "In progress"
    : `${date.toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" })}, ${fmtTime(g.start)}`;

  els.sheetBody.innerHTML = `
    <h2 id="sheet-title" class="matchup">
      <span class="side">${logoHTML(g.away)}<span class="abbrev">${esc(g.away.abbrev)}</span><span class="where">${esc(g.away.short)}</span></span>
      ${middle}
      <span class="side">${logoHTML(g.home)}<span class="abbrev">${esc(g.home.abbrev)}</span><span class="where">${esc(g.home.short)}</span></span>
    </h2>
    <p class="when">${esc(when)}${g.venue ? `<br>${esc(g.venue)}` : ""}</p>
    ${compareHTML(g)}
    <div id="model-details"></div>
    <button class="sim-btn" type="button" data-sim>
      <span class="sim-btn-fill" aria-hidden="true"></span>
      <span class="sim-btn-label">${mayBeSignedIn() ? "Run simulation" : "Sign in to run simulations"}</span>
    </button>
    <div id="sim-results"></div>`;
  state.sheetGame = g;
  state.sheetDate = state.selected;
  const cached = simCache.get(simKey(g));
  if (cached) showResults(g, cached);
  els.sheet.showModal();
  loadModelDetails(g);
}

// ------------------------------------------------------------------ sign-in gate

// Simulations are for signed-in members. (A convenience gate: the site and
// its code are public, and the simulation runs on the phone.)
const mayBeSignedIn = () => !account.configured() || account.hasStoredSession();

async function gateThenSimulate(g) {
  if (!account.configured()) { runSimulation(g); return; }
  const btn = els.sheetBody.querySelector("[data-sim]");
  const label = btn.querySelector(".sim-btn-label");
  btn.disabled = true;
  label.textContent = "Checking sign-in…";
  const user = await account.currentUser().catch(() => null);
  btn.disabled = false;
  if (user) { runSimulation(g); return; }
  label.textContent = "Sign in to run simulations";
  els.sheetBody.querySelector("#sim-results").innerHTML = `<p class="sim-note gate-note">Simulations are for members.
    <button type="button" class="link-btn" data-goto="bets">Sign in on the Bets tab</button> (the app's owner sets up accounts).</p>`;
}

// Signing in or out elsewhere (the Bets tab): forget results run under the old state.
window.addEventListener("hockeysim:auth", () => {
  simCache.clear();
  state.details.clear();
  if (state.sheetGame && els.sheet.open) openSheet(state.sheetGame);
});

// ------------------------------------------------------------------ simulation

const simCache = new Map();   // game id + picks -> { result, inputs }
let runId = 0;

function pct(p, digits = 0) {
  if (p > 0 && p < 0.005 && digits === 0) return "<1%";
  return `${(100 * p).toFixed(digits)}%`;
}

function oddsText(p) {
  const o = americanOdds(p);
  if (o === null) return "–";
  return o > 0 ? `+${o}` : `−${Math.abs(o)}`;
}

/** A probability with its fair American odds beneath (or beside) it. */
const withOdds = (p, digits = 0) => `${pct(p, digits)}<small class="odds">${oddsText(p)}</small>`;

// Simulations run on the server (the model API), with this device's goalie
// and lineup picks.
async function runSimulation(g) {
  const btn = els.sheetBody.querySelector("[data-sim]");
  const label = btn.querySelector(".sim-btn-label");
  btn.disabled = true;
  btn.classList.add("is-running", "is-waiting");
  label.textContent = "Simulating…";
  const key = simKey(g);
  const id = ++runId;
  try {
    const out = await account.callModel({ action: "simulate", gameId: g.id,
      goalieOverride: picksFor(String(g.id)), lineup: lineupPicks(g) });
    const entry = { result: out.result, inputs: out.inputs };
    simCache.set(key, entry);
    if (id === runId && state.sheetGame?.id === g.id && simKey(state.sheetGame) === key) showResults(g, entry);
  } catch (err) {
    if (id !== runId) return;
    btn.disabled = false;
    btn.classList.remove("is-running", "is-waiting");
    label.textContent = "Run simulation";
    els.sheetBody.querySelector("#sim-results").innerHTML =
      `<p class="sim-note">The simulation didn't run: ${esc(err.message)}</p>`;
  }
}

function splitRow(label, a, h, fmt = (p) => withOdds(p)) {
  return `<div class="res-row"><span class="res-val away">${fmt(a)}</span><span class="res-label">${esc(label)}</span><span class="res-val home">${fmt(h)}</span></div>`;
}

function b2bNote(g, inputs) {
  const tired = ["away", "home"].filter((s) => inputs[s].context?.b2b).map((s) => g[s].abbrev);
  if (!tired.length) return "";
  return `${tired.join(" and ")} ${tired.length > 1 ? "are" : "is"} on the second night of a back-to-back, worth about ${Math.round(100 * (Math.exp(inputs.params.b2bPenalty) - 1))}% fewer goals scored and more allowed. `;
}

function specialTeamsNote(g, inputs) {
  if (!inputs.usesSpecialTeams) return "with special teams counted through those overall goals and xG (each team's power-play and penalty-kill numbers are in the comparison above)";
  const pct = (x) => `${x >= 1 ? "+" : "−"}${Math.abs(Math.round(100 * (x - 1)))}%`;
  const side = (s) => {
    const t = inputs[s];
    return `${g[s].abbrev} power play ${pct(t.powerPlay)}, penalty kill ${pct(1 / t.penaltyKill)}`;
  };
  return `with team special teams (vs league average, + is better: ${side("away")}; ${side("home")})`;
}

function historyNote(inputs) {
  if (!inputs.usesHistory) return " this season";
  const p = inputs.params, bits = [];
  if (p.recencyDecay < 1) bits.push("recent games count more");
  if (p.offseasonCarryover > 0) bits.push(`last season counts at ${Math.round(100 * p.offseasonCarryover)}%`);
  return bits.length ? ` (${bits.join("; ")})` : " this season";
}

function calibrationNote(inputs) {
  const c = inputs.calibration;
  if (!c?.calibratedAt) return "League-level settings are the built-in defaults.";
  const when = new Date(c.calibratedAt).toLocaleDateString([], { month: "short", day: "numeric" });
  const games = Math.round(c.gamesPlayed || 0);
  return games > 0
    ? `League-level settings recalibrated ${when}, blending ${games.toLocaleString()} games this season with last season.`
    : `League-level settings recalibrated ${when} from last season.`;
}

function goalieSummary(g, inputs) {
  const line = (side) => {
    const opts = inputs[side].goalieOptions || [];
    if (!opts.length) return "";
    const text = opts[0].picked
      ? `${esc(opts[0].name)} <span class="tag">your pick</span>`
      : opts.filter((o) => o.p >= 0.05).map((o) => `${esc(o.name)} ${Math.round(100 * o.p)}%`).join(", ");
    return `<div><dt>${esc(g[side].abbrev)} in goal</dt><dd class="goalie-dd">${text}</dd></div>`;
  };
  const rows = line("away") + line("home");
  return rows ? `<dl class="res-list goalie-list">${rows}</dl>` : "";
}

function lineupSummary(g, inputs) {
  const line = (side) => {
    const l = inputs[side].lineup;
    if (!l) return "";
    const pctOf = (f) => `${f >= 1 ? "+" : "−"}${Math.abs(Math.round(100 * (f - 1)))}%`;
    return `<div><dt>${esc(g[side].abbrev)} lineup</dt><dd class="goalie-dd">scoring ${pctOf(l.offFactor)}, allowing ${pctOf(l.defFactor)}</dd></div>`;
  };
  const rows = line("away") + line("home");
  return rows ? `<dl class="res-list goalie-list">${rows}</dl>` : "";
}

function showResults(g, { result: r, inputs }) {
  const btn = els.sheetBody.querySelector("[data-sim]");
  if (btn) {
    btn.disabled = false;
    btn.classList.remove("is-running", "is-waiting");
    btn.querySelector(".sim-btn-label").textContent = "Run again";
    btn.querySelector(".sim-btn-fill").style.width = "0%";
  }
  const A = g.away.abbrev, H = g.home.abbrev;
  const awayPct = Math.round(100 * r.away.win);
  const scores = r.topScores.map((s) =>
    `<li><span>${esc(A)} ${s.away}, ${esc(H)} ${s.home}</span><span>${withOdds(s.p, 1)}</span></li>`).join("");
  const notes = inputs.notes.map((n) => `<br>${esc(n)}`).join("");

  state.lastResult = { id: g.id, r };
  els.sheetBody.querySelector("#sim-results").innerHTML = `
    <section class="results" aria-label="Simulation results">
      ${goalieSummary(g, inputs)}
      ${lineupSummary(g, inputs)}
      <h3 class="res-heading">Win probability</h3>
      <div class="winbar" role="img" aria-label="${esc(`${A} ${pct(r.away.win)}, ${H} ${pct(r.home.win)}`)}">
        <span class="winbar-away" style="width:${awayPct}%"></span>
      </div>
      <div class="res-row big">
        <span class="res-val away">${withOdds(r.away.win)}</span>
        <span class="res-label">To win<br>(fair odds)</span>
        <span class="res-val home">${withOdds(r.home.win)}</span>
      </div>
      ${splitRow("In regulation", r.away.REG, r.home.REG)}
      ${inputs.playoff ? splitRow("In overtime", r.away.OT, r.home.OT)
        : `${splitRow("In overtime", r.away.OT, r.home.OT)}${splitRow("In a shootout", r.away.SO, r.home.SO)}`}
      ${splitRow("Average goals", r.meanGoals.away, r.meanGoals.home, (x) => x.toFixed(2))}
      ${splitRow("Power-play goals", r.special.away.ppGoals, r.special.home.ppGoals, (x) => x.toFixed(2))}

      ${linesHTML(g, r)}

      <h3 class="res-heading">The game</h3>
      <dl class="res-list">
        <div><dt>Goes to overtime</dt><dd>${withOdds(r.pOvertime)}</dd></div>
        <div><dt>Empty-net goal scored</dt><dd>${withOdds(r.pEmptyNetGoal)}</dd></div>
        <div><dt>Average total goals</dt><dd>${r.meanTotal.toFixed(2)}</dd></div>
      </dl>

      <h3 class="res-heading">Most likely final scores</h3>
      <ol class="scores">${scores}</ol>

      <p class="sim-note">${r.n.toLocaleString()} simulated games. ${inputs.usesXg
        ? `Simulated on the server. Team ratings blend expected goals (xG, ${Math.round(100 * inputs.params.xgWeight)}%) with actual goals for and against${historyNote(inputs)}`
        : "Team ratings use actual goals for and against this season (no shot data yet)"}, ${specialTeamsNote(g, inputs)}. ${b2bNote(g, inputs)}${calibrationNote(inputs)}
        Each probability is accurate to about ±${(100 * r.errorMargin).toFixed(1)}%. Odds under each probability are
        fair American odds (no bookmaker margin).${notes}</p>
    </section>`;
}

// ------------------------------------------------------------------ betting lines

// Sportsbook prices you've typed in, per game: { key: "-110", total: 6.5 }, saved on this device.
function loadBook() {
  try { return JSON.parse(localStorage.getItem("bookOdds") || "{}"); } catch { return {}; }
}
function bookFor(gameId) { return loadBook()[gameId] || {}; }
function saveBook(gameId, patch) {
  const all = loadBook();
  const cur = { ...(all[gameId] || {}), ...patch };
  for (const k of Object.keys(cur)) if (cur[k] === "" || cur[k] == null) delete cur[k];
  if (Object.keys(cur).length) all[gameId] = cur; else delete all[gameId];
  const keep = new Set((state.data?.days || []).flatMap((d) => d.games.map((x) => String(x.id))));
  for (const k of Object.keys(all)) if (!keep.has(k)) delete all[k];
  try { localStorage.setItem("bookOdds", JSON.stringify(all)); } catch { /* storage unavailable */ }
}

const lineNum = (x) => (Number.isInteger(x) ? String(x) : x.toFixed(1));
const signedLine = (x) => `${x > 0 ? "+" : "−"}${lineNum(Math.abs(x))}`;

/** Expected value of a bet at the typed price: { text, cls }. */
function evCell(pWin, pLose, text) {
  const o = parseOdds(text);
  if (!o) return { text: text ? "?" : "", cls: "" };
  const ev = expectedValue(pWin, pLose, o.profit);
  const mag = Math.abs(100 * ev);
  return { text: `${ev >= 0 ? "+" : "−"}${mag.toFixed(mag >= 10 ? 0 : 1)}%`, cls: ev > 0 ? "pos" : "neg" };
}

function lineRow(gameId, key, label, pWin, pLose, book, spec) {
  const fair = fairOdds(pWin, pLose);
  const fairText = fair === null ? "–" : fair > 0 ? `+${fair}` : `−${Math.abs(fair)}`;
  const ev = evCell(pWin, pLose, book[key] || "");
  const push = 1 - pWin - pLose > 0.0005 ? `<small>push ${pct(1 - pWin - pLose)}</small>` : "";
  return `<div class="line-row${ev.cls === "pos" ? " has-value" : ""}" data-line="${esc(key)}" data-pwin="${pWin}" data-plose="${pLose}"
      data-market="${spec.market}" data-side="${spec.side}" data-lineval="${spec.line ?? ""}" data-fair="${fair ?? ""}">
      <span class="line-label">${label}</span>
      <span class="line-prob">${pct(pWin, 1)}${push}</span>
      <span class="line-fair">${fairText}</span>
      <input class="line-book" type="text" inputmode="text" enterkeyhint="done" autocomplete="off" spellcheck="false"
        placeholder="odds" value="${esc(book[key] || "")}" aria-label="${esc(`Sportsbook odds for ${label.replace(/<[^>]+>/g, "")}`)}">
      <span class="line-ev ${ev.cls}">${ev.text}</span>
      ${account.configured() ? `<button type="button" class="line-track" data-track aria-label="${esc(`Track a bet on ${label.replace(/<[^>]+>/g, "")}`)}">+</button>` : ""}
    </div>`;
}

function linesHTML(g, r) {
  if (!r.totalDist || !r.marginDist) return "";
  const id = String(g.id), book = bookFor(id);
  const A = esc(g.away.abbrev), H = esc(g.home.abbrev);
  const head = `<div class="line-row line-head"><span></span><span>Chance</span><span>Fair</span><span>Book</span><span>Value</span>${account.configured() ? "<span></span>" : ""}</div>`;
  const ml = [["away", A], ["home", H]].map(([side, ab]) =>
    lineRow(id, `ml-${side}`, ab, r[side].win, 1 - r[side].win, book, { market: "moneyline", side })).join("");
  const pl = [["away", A], ["home", H]].flatMap(([side, ab]) => [-1.5, 1.5].map((h) => {
    const s = spreadLine(r.marginDist, r.marginOffset, side, h);
    return lineRow(id, `pl-${side}${h}`, `${ab} ${signedLine(h)}`, s.win, s.lose, book, { market: "spread", side, line: h });
  })).join("");
  const line = Number(book.total) || defaultTotal(r.totalDist);
  const t = totalLine(r.totalDist, line);
  const tot = lineRow(id, `over@${line}`, `Over ${lineNum(line)}`, t.over, t.under, book, { market: "total", side: "over", line })
    + lineRow(id, `under@${line}`, `Under ${lineNum(line)}`, t.under, t.over, book, { market: "total", side: "under", line });
  return `<section class="lines" data-lines>
      <h3 class="res-heading">Compare with a sportsbook</h3>
      <p class="explain">Type a sportsbook's price (−110, +135, or decimal 1.91) next to any line. Value is the
        expected profit per dollar bet if the simulation's chances are right: positive means the book pays more than
        the fair odds. A big edge usually means the market knows something the model doesn't (a late scratch, a
        goalie change), so check the lineups and starters first.</p>
      <h4 class="line-group">Moneyline</h4>
      ${head}${ml}
      <h4 class="line-group">Puck line</h4>
      ${head}${pl}
      <h4 class="line-group">Total goals
        <span class="total-step">
          <button type="button" data-total-step="-0.5" aria-label="Lower the total line">−</button>
          <span>${lineNum(line)}</span>
          <button type="button" data-total-step="0.5" aria-label="Raise the total line">+</button>
        </span>
      </h4>
      ${head}${tot}
      <p class="explain">Totals and puck lines count a shootout winner as a goal, as sportsbooks do. On a
        whole-number total a push refunds the bet; fair odds leave it out.${account.configured()
          ? " Tap + on a line with a price to track the bet on the Bets tab." : ""}</p>
    </section>`;
}

// Tracking a bet: tap + on a row with a price, enter the stake, save.
const lastStake = () => { try { return localStorage.getItem("lastStake") || "10"; } catch { return "10"; } };

function closeTrackForms() {
  els.sheetBody.querySelectorAll(".track-form").forEach((f) => f.remove());
}

async function openTrackForm(row) {
  const g = state.sheetGame;
  closeTrackForms();
  const form = document.createElement("form");
  form.className = "track-form";
  const odds = parseOdds(row.querySelector(".line-book").value);
  const label = row.querySelector(".line-label").textContent;
  if (!odds) {
    form.innerHTML = `<p>Type the sportsbook's price for ${esc(label)} first.</p>`;
    row.after(form);
    row.querySelector(".line-book").focus();
    return;
  }
  if (new Date(g.start) <= new Date() || isLive(g) || isFinal(g)) {
    form.innerHTML = "<p>This game has started; bets can only be tracked before puck drop.</p>";
    row.after(form);
    return;
  }
  form.innerHTML = "<p>Checking sign-in…</p>";
  row.after(form);
  const user = await account.currentUser().catch(() => null);
  if (!user) {
    form.innerHTML = `<p>Sign in on the <button type="button" class="link-btn" data-goto="bets">Bets tab</button> to track bets.</p>`;
    return;
  }
  form.dataset.key = row.dataset.line;
  form.innerHTML = `<span class="track-what">${esc(label)} at ${odds.american > 0 ? "+" : "−"}${Math.abs(odds.american)}</span>
      <label class="track-stake">Stake $<input name="stake" type="text" inputmode="decimal" value="${esc(lastStake())}" aria-label="Stake in dollars"></label>
      <button type="submit">Save bet</button>
      <span class="track-msg" role="status"></span>`;
}

async function saveTrackForm(form) {
  const g = state.sheetGame;
  const row = els.sheetBody.querySelector(`[data-line="${CSS.escape(form.dataset.key)}"]`);
  const msg = form.querySelector(".track-msg");
  const odds = row && parseOdds(row.querySelector(".line-book").value);
  const stake = Number(String(form.stake.value).replace(/[$,\s]/g, ""));
  if (!odds) { msg.textContent = "Enter the price first."; return; }
  if (!(stake > 0)) { msg.textContent = "Enter a stake."; return; }
  const pWin = Number(row.dataset.pwin), pLose = Number(row.dataset.plose);
  const bet = {
    game_id: g.id, game_date: state.sheetDate, start_time: g.start, home: g.home.abbrev, away: g.away.abbrev,
    market: row.dataset.market, side: row.dataset.side,
    line: row.dataset.lineval === "" ? null : Number(row.dataset.lineval),
    odds_american: odds.american, stake,
    model_win: Number(pWin.toFixed(4)), model_push: Number(Math.max(0, 1 - pWin - pLose).toFixed(4)),
    fair_odds: row.dataset.fair === "" ? null : Number(row.dataset.fair),
    ev: Number(expectedValue(pWin, pLose, odds.profit).toFixed(4)),
  };
  form.querySelector("button").disabled = true;
  msg.textContent = "Saving…";
  try {
    const saved = await account.addBet(bet);
    noteNewBet(saved);
    try { localStorage.setItem("lastStake", String(stake)); } catch { /* storage unavailable */ }
    form.innerHTML = `<p>Tracked: ${esc(row.querySelector(".line-label").textContent)}, $${esc(stake)} at
      ${odds.american > 0 ? "+" : "−"}${Math.abs(odds.american)}. See the <button type="button" class="link-btn" data-goto="bets">Bets tab</button>.</p>`;
  } catch (err) {
    msg.textContent = err.message;
    form.querySelector("button").disabled = false;
  }
}

els.sheetBody.addEventListener("submit", (e) => {
  const form = e.target.closest(".track-form");
  if (!form) return;
  e.preventDefault();
  saveTrackForm(form);
});

function refreshLines(g) {
  const sec = els.sheetBody.querySelector("[data-lines]");
  if (!sec || state.lastResult?.id !== g.id) return;
  sec.outerHTML = linesHTML(g, state.lastResult.r);
}

els.sheetBody.addEventListener("input", (e) => {
  const input = e.target.closest(".line-book");
  const g = state.sheetGame;
  if (!input || !g) return;
  const row = input.closest("[data-line]");
  saveBook(String(g.id), { [row.dataset.line]: input.value.trim() });
  const ev = evCell(Number(row.dataset.pwin), Number(row.dataset.plose), input.value.trim());
  const cell = row.querySelector(".line-ev");
  cell.textContent = ev.text;
  cell.className = `line-ev ${ev.cls}`;
  row.classList.toggle("has-value", ev.cls === "pos");
});

function afterPickChange(g) {
  const cached = simCache.get(simKey(g));
  const btn = els.sheetBody.querySelector("[data-sim]");
  if (cached) {
    showResults(g, cached);
  } else {
    els.sheetBody.querySelector("#sim-results").innerHTML = "";
    if (btn) btn.querySelector(".sim-btn-label").textContent = mayBeSignedIn() ? "Run simulation" : "Sign in to run simulations";
  }
}

els.sheetBody.addEventListener("click", (e) => {
  if (e.target.closest("[data-sim]") && state.sheetGame) { gateThenSimulate(state.sheetGame); return; }
  if (e.target.closest("[data-reload-details]") && state.sheetGame) { loadModelDetails(state.sheetGame); return; }
  const track = e.target.closest("[data-track]");
  if (track && state.sheetGame) { openTrackForm(track.closest("[data-line]")); return; }
  const goto = e.target.closest("[data-goto]");
  if (goto) { els.sheet.close(); showView(goto.dataset.goto); return; }
  const step = e.target.closest("[data-total-step]");
  if (step && state.sheetGame && state.lastResult) {
    const g = state.sheetGame, r = state.lastResult.r;
    const cur = Number(bookFor(String(g.id)).total) || defaultTotal(r.totalDist);
    const next = Math.min(12.5, Math.max(1.5, cur + Number(step.dataset.totalStep)));
    saveBook(String(g.id), { total: next });
    refreshLines(g);
    return;
  }
  const p = e.target.closest("[data-player]");
  const g = state.sheetGame;
  if (p && g) {
    toggleLineup(String(g.id), p.dataset.lineupSide, p.dataset.player, p.dataset.last === "1");
    refreshLineups(g);
    afterPickChange(g);
  }
});

// Changing a goalie pick: save it, then show results for that combination if
// already simulated, or invite a new run.
els.sheetBody.addEventListener("change", (e) => {
  const sel = e.target.closest("[data-goalie-side]");
  const g = state.sheetGame;
  if (!sel || !g) return;
  setPick(String(g.id), sel.dataset.goalieSide, sel.value);
  afterPickChange(g);
});

els.sheet.querySelector(".sheet-close").addEventListener("click", () => els.sheet.close());
els.sheet.addEventListener("close", () => { state.sheetGame = null; });
// Tap on the dimmed backdrop closes the sheet.
els.sheet.addEventListener("click", (e) => { if (e.target === els.sheet) els.sheet.close(); });

// ------------------------------------------------------------------ events

els.strip.addEventListener("click", (e) => {
  const btn = e.target.closest(".day-btn");
  if (!btn) return;
  state.selected = btn.dataset.date;
  try { sessionStorage.setItem("selectedDate", state.selected); } catch {}
  render();
  window.scrollTo({ top: 0 });
});

els.content.addEventListener("click", (e) => {
  const btn = e.target.closest(".game");
  if (btn) {
    const day = state.data.days.find((d) => d.date === state.selected);
    openSheet(day.games[Number(btn.dataset.index)]);
    return;
  }
  if (e.target.closest("[data-retry]")) load();
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && Date.now() - state.loadedAt > REFRESH_AFTER_MS) load();
});

darkMode.addEventListener?.("change", () => state.data && render());

// ------------------------------------------------------------------ loading

function pickDefaultDate(days) {
  const dates = days.map((d) => d.date);
  let saved = null;
  try { saved = sessionStorage.getItem("selectedDate"); } catch {}
  if (saved && dates.includes(saved)) return saved;
  const today = localISODate();
  return dates.find((d) => d >= today) ?? dates[dates.length - 1];
}

async function load() {
  try {
    const resp = await fetch(DATA_URL, { cache: "no-cache" });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    if (!data.days?.length) throw new Error("empty schedule");
    state.data = data;
    state.schedule = null;   // rebuilt from the new data on demand
    state.loadedAt = Date.now();
    if (!state.selected || !data.days.some((d) => d.date === state.selected)) {
      state.selected = pickDefaultDate(data.days);
    }
    render();
  } catch (err) {
    console.error(err);
    if (state.data) return;   // keep showing what we have
    els.content.innerHTML = `<p class="status-msg">The schedule didn't load. Check your connection, then try again.<br>
      <button type="button" data-retry>Try again</button></p>`;
  }
}

// ------------------------------------------------------------------ views

const views = {
  games: document.getElementById("view-games"),
  scorecard: document.getElementById("view-scorecard"),
  bets: document.getElementById("view-bets"),
};
const betsEl = document.getElementById("bets");
initBets(betsEl);
const tabbar = document.querySelector(".tabbar");
const scorecardEl = document.getElementById("scorecard");
const score = { live: null, backtest: null, which: null, loaded: false, loading: null };

async function fetchJSON(url) {
  try {
    const resp = await fetch(url, { cache: "no-cache" });
    return resp.ok ? await resp.json() : null;
  } catch {
    return null;
  }
}

async function loadScorecard(force = false) {
  if (score.loading) return score.loading;
  if (score.loaded && !force) return;
  score.loading = (async () => {
    const [live, backtest] = await Promise.all([fetchJSON(`${DATA_BASE}/predictions.json`), fetchJSON(`${DATA_BASE}/backtest.json`)]);
    score.live = live;
    score.backtest = backtest;
    score.loaded = true;
    // Default to this season once it has a meaningful number of results.
    if (!score.which) {
      const scored = (live?.records || []).filter((r) => r.result).length;
      score.which = scored >= 50 || !backtest ? "live" : "backtest";
    }
  })();
  await score.loading;
  score.loading = null;
}

async function showScorecard() {
  await loadScorecard();
  renderScorecard(scorecardEl, score);
}

function showView(name) {
  for (const [key, el] of Object.entries(views)) el.hidden = key !== name;
  tabbar.querySelectorAll("button").forEach((b) => {
    if (b.dataset.view === name) b.setAttribute("aria-current", "page");
    else b.removeAttribute("aria-current");
  });
  window.scrollTo({ top: 0 });
  if (name === "scorecard") showScorecard();
  if (name === "bets") showBets();
}

tabbar.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-view]");
  if (btn) showView(btn.dataset.view);
});

scorecardEl.addEventListener("click", (e) => {
  const tab = e.target.closest("[data-which]");
  if (!tab) return;
  score.which = tab.dataset.which;
  renderScorecard(scorecardEl, score);
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && score.loaded) {
    loadScorecard(true).then(() => { if (!views.scorecard.hidden) renderScorecard(scorecardEl, score); });
  }
});

load();

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch((err) => console.warn("SW registration failed", err));
}
