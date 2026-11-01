// Bets tab: sign in, then your tracked bets and how they're going.

import * as account from "./account.js";
import { betStats, describeBet } from "./bets.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
})[c]);

const ui = { el: null, user: undefined, bets: null, email: "", msg: "", note: "", busy: false, changingPw: false };

const money = (x, sign = true) => {
  const v = Math.abs(Number(x) || 0);
  const s = v >= 1000 ? Math.round(v).toLocaleString() : v.toFixed(2).replace(/\.00$/, "");
  return `${sign ? (x > 0 ? "+" : x < 0 ? "−" : "") : ""}$${s}`;
};
const oddsText = (o) => (o > 0 ? `+${o}` : `−${Math.abs(o)}`);
const pctText = (x, d = 1) => `${x >= 0 ? "+" : "−"}${Math.abs(100 * x).toFixed(d)}%`;
const day = (iso) => new Date(iso).toLocaleDateString([], { month: "short", day: "numeric" });

// ------------------------------------------------------------------ rendering

function signInHTML() {
  const msg = ui.msg ? `<p class="form-msg" role="alert">${esc(ui.msg)}</p>` : "";
  return `<form class="signin" data-form="password">
      <p class="explain">Sign in to run game simulations, save bets from the sportsbook comparison, and track how
        they do. Accounts are
        invite-only: the app's owner sets you up with your email and a starting password, which you can change
        after signing in.</p>
      <input name="email" type="email" inputmode="email" autocomplete="username" placeholder="you@example.com"
        value="${esc(ui.email)}" aria-label="Email" required>
      <input name="password" type="password" autocomplete="current-password" placeholder="Password"
        aria-label="Password" required>
      <button type="submit" ${ui.busy ? "disabled" : ""}>${ui.busy ? "Signing in…" : "Sign in"}</button>
      ${msg}
    </form>`;
}

function passwordFormHTML() {
  return `<form class="signin pw-form" data-form="newpw">
      <input name="password" type="password" autocomplete="new-password" minlength="8" placeholder="New password (8+ characters)"
        aria-label="New password" required>
      <button type="submit" ${ui.busy ? "disabled" : ""}>${ui.busy ? "Saving…" : "Save new password"}</button>
      <button type="button" class="link-btn" data-act="cancelpw">Cancel</button>
    </form>`;
}

function tile(label, value, note, cls = "") {
  return `<div class="tile"><div class="tile-label">${esc(label)}</div>
    <div class="tile-value ${cls}">${value}</div>${note ? `<div class="tile-note">${note}</div>` : ""}</div>`;
}

/** Cumulative profit vs what the model expected, with a +/- 2 sd band. */
function chartHTML(series) {
  if (series.length < 2) return "";
  const W = 340, H = 190, L = 44, R = 10, T = 12, B = 26;
  const pts = [{ profit: 0, expected: 0, lo: 0, hi: 0 }, ...series];
  const ys = pts.flatMap((p) => [p.profit, p.lo, p.hi]);
  let lo = Math.min(0, ...ys), hi = Math.max(0, ...ys);
  if (hi - lo < 1) { hi += 1; lo -= 1; }
  const x = (i) => L + (i / (pts.length - 1)) * (W - L - R);
  const y = (v) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
  const path = (k) => pts.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p[k]).toFixed(1)}`).join("");
  const band = `${pts.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.hi).toFixed(1)}`).join("")}`
    + `${[...pts].reverse().map((p, j) => `L${x(pts.length - 1 - j).toFixed(1)},${y(p.lo).toFixed(1)}`).join("")}Z`;
  const ticks = [lo, 0, hi].filter((v, i, a) => a.indexOf(v) === i);
  return `<svg class="chart bets-chart" viewBox="0 0 ${W} ${H}" role="img"
      aria-label="Cumulative profit ${esc(money(series.at(-1).profit))}, expected ${esc(money(series.at(-1).expected))}">
      ${ticks.map((v) => `<line class="grid${v === 0 ? " zero" : ""}" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/>
        <text class="tick" x="${L - 6}" y="${y(v) + 4}" text-anchor="end">${esc(money(v))}</text>`).join("")}
      <path class="band" d="${band}"/>
      <path class="expected" d="${path("expected")}"/>
      <path class="actual" d="${path("profit")}"/>
      <text class="tick" x="${L}" y="${H - 6}">first bet</text>
      <text class="tick" x="${W - R}" y="${H - 6}" text-anchor="end">bet ${series.length}</text>
    </svg>
    <p class="legend"><span class="key actual"></span>Your profit <span class="key expected"></span>Expected by the model
      <span class="key band"></span>Range from luck (95%)</p>`;
}

function betRow(b) {
  const when = `${day(b.start_time)} · ${esc(b.away)} at ${esc(b.home)}`;
  const model = Number.isFinite(Number(b.ev)) ? `model ${pctText(Number(b.ev))}` : "";
  let right;
  if (b.status === "open") {
    right = `<span class="bet-stake">${money(b.stake, false)}</span>
      <button type="button" class="link-btn" data-act="delete" data-id="${esc(b.id)}">Remove</button>`;
  } else {
    const label = { won: "Won", lost: "Lost", push: "Push", void: "Void" }[b.status];
    const score = b.final_home != null ? `${b.final_away}–${b.final_home}${b.ended_in && b.ended_in !== "REG" ? ` ${b.ended_in}` : ""}` : "";
    right = `<span class="bet-profit ${b.status}">${b.status === "void" ? "$0" : money(b.profit)}</span><small>${label}${score ? ` · ${esc(score)}` : ""}</small>`;
  }
  return `<li class="bet">
      <span class="bet-main">${esc(describeBet(b))} <span class="bet-odds">${oddsText(b.odds_american)}</span>
        <small>${when}${model ? ` · ${model}` : ""}</small></span>
      <span class="bet-right">${right}</span>
    </li>`;
}

function dashboardHTML() {
  const bets = ui.bets || [];
  const s = betStats(bets);
  const open = bets.filter((b) => b.status === "open").sort((a, b) => a.start_time.localeCompare(b.start_time));
  const done = bets.filter((b) => b.status !== "open");
  const settled = s.won + s.lost + s.push;
  const head = `<p class="who">Signed in as <strong>${esc(ui.user.email)}</strong>
      <button type="button" class="link-btn" data-act="changepw">Change password</button>
      <button type="button" class="link-btn" data-act="signout">Sign out</button></p>
    ${ui.changingPw ? passwordFormHTML() : ""}
    ${ui.note ? `<p class="form-note" role="status">${esc(ui.note)}</p>` : ""}
    ${ui.msg ? `<p class="form-msg" role="alert">${esc(ui.msg)}</p>` : ""}`;
  if (!bets.length) {
    return `${head}<p class="empty">No bets yet. Run a simulation, type the sportsbook's price next to a line,
      and tap <strong>+</strong> to track it.</p>`;
  }
  const luck = settled ? ((s.profit - s.expected) / (s.sd || 1)) : 0;
  const verdict = !settled ? "" : Math.abs(luck) < 2
    ? "within the range luck alone produces"
    : luck > 0 ? "better than luck alone usually gives" : "worse than luck alone usually gives";
  return `${head}
    <div class="tiles">
      ${tile("Record", `${s.won}–${s.lost}${s.push ? `–${s.push}` : ""}`, `won–lost${s.push ? "–push" : ""}${s.open ? `; ${s.open} open (${money(s.openStake, false)})` : ""}`)}
      ${tile("Profit", money(s.profit), `on ${money(s.staked, false)} staked`, s.profit > 0 ? "pos" : s.profit < 0 ? "neg" : "")}
      ${tile("Return", s.roi === null ? "–" : pctText(s.roi), "profit per dollar staked")}
      ${tile("Model expected", money(s.expected), settled ? `± ${money(2 * s.sd, false)} from luck; you're ${verdict}` : "")}
    </div>
    ${settled >= 2 ? `<h3 class="res-heading">Profit over time</h3>${chartHTML(s.series)}` : ""}
    <p class="explain">"Model expected" adds up each settled bet's expected value at the price you took. If the model's
      edges are real, your profit should track it; it takes hundreds of bets before luck stops dominating.</p>
    ${open.length ? `<h3 class="res-heading">Open</h3><ol class="bets">${open.map(betRow).join("")}</ol>` : ""}
    ${done.length ? `<h3 class="res-heading">Settled</h3><ol class="bets">${done.slice(0, 100).map(betRow).join("")}</ol>` : ""}
    <p class="explain">Bets settle automatically within an hour of the final horn. Puck lines and totals count a shootout
      winner as a goal, as sportsbooks do.</p>`;
}

function render() {
  const el = ui.el;
  if (!account.configured()) { el.innerHTML = `<p class="status-msg">Accounts aren't set up for this app.</p>`; return; }
  if (ui.user === undefined) { el.innerHTML = `<p class="status-msg">Loading…</p>`; return; }
  el.innerHTML = ui.user ? (ui.bets ? dashboardHTML() : `<p class="status-msg">Loading your bets…</p>`) : signInHTML();
}

// ------------------------------------------------------------------ actions

async function refresh() {
  try {
    ui.user = await account.currentUser();
    if (ui.user) ui.bets = await account.listBets();
  } catch (err) {
    ui.msg = err.message;
    ui.bets ??= [];
  }
  render();
}

export function initBets(el) {
  ui.el = el;
  el.addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.target;
    ui.msg = ""; ui.note = ""; ui.busy = true;
    try {
      if (form.dataset.form === "password") {
        ui.email = form.email.value.trim();
        const pw = form.password.value;
        render();
        await account.signInPassword(ui.email, pw);
        window.dispatchEvent(new CustomEvent("hockeysim:auth"));
        ui.busy = false;
        await refresh();
        return;
      }
      if (form.dataset.form === "newpw") {
        const pw = form.password.value;
        if (pw.length < 8) throw new Error("Use at least 8 characters.");
        render();
        await account.changePassword(pw);
        ui.changingPw = false;
        ui.note = "Password changed.";
      }
    } catch (err) {
      ui.msg = err.message;
    }
    ui.busy = false;
    render();
    if (ui.msg) el.querySelector('input[type="password"]')?.focus();
  });
  el.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-act]");
    if (!btn) return;
    ui.msg = "";
    ui.note = "";
    if (btn.dataset.act === "changepw") { ui.changingPw = true; render(); el.querySelector(".pw-form input")?.focus(); }
    if (btn.dataset.act === "cancelpw") { ui.changingPw = false; render(); }
    if (btn.dataset.act === "signout") {
      await account.signOut();
      ui.user = null; ui.bets = null; ui.changingPw = false;
      window.dispatchEvent(new CustomEvent("hockeysim:auth"));
      render();
    }
    if (btn.dataset.act === "delete") {
      btn.disabled = true;
      try { await account.deleteBet(btn.dataset.id); ui.bets = ui.bets.filter((b) => b.id !== btn.dataset.id); }
      catch (err) { ui.msg = err.message; }
      render();
    }
  });
}

/** Show the tab (reloads bets so new settlements appear). */
export async function showBets() {
  render();
  await refresh();
}

/** A bet was just saved elsewhere (the game sheet): include it next time. */
export function noteNewBet(bet) {
  if (ui.bets) ui.bets = [bet, ...ui.bets];
}
