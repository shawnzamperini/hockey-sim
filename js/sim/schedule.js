// Schedule context for a team going into a game: rest, back-to-backs, travel.
// Shared by the app, the backtest and the analysis scripts.
//
// Arena locations and standard-time UTC offsets (hours). Neutral-site games
// (Global Series, outdoor games) are treated as being at the home team's arena.

export const ARENAS = {
  ANA: [33.81, -117.88, -8], ARI: [33.42, -111.93, -7], BOS: [42.37, -71.06, -5],
  BUF: [42.88, -78.88, -5], CAR: [35.80, -78.72, -5], CBJ: [39.97, -83.01, -5],
  CGY: [51.04, -114.05, -7], CHI: [41.88, -87.67, -6], COL: [39.75, -105.01, -7],
  DAL: [32.79, -96.81, -6], DET: [42.34, -83.06, -5], EDM: [53.55, -113.50, -7],
  FLA: [26.16, -80.33, -5], LAK: [34.04, -118.27, -8], MIN: [44.94, -93.10, -6],
  MTL: [45.50, -73.57, -5], NJD: [40.73, -74.17, -5], NSH: [36.16, -86.78, -6],
  NYI: [40.71, -73.73, -5], NYR: [40.75, -73.99, -5], OTT: [45.30, -75.93, -5],
  PHI: [39.90, -75.17, -5], PIT: [40.44, -79.99, -5], SEA: [47.62, -122.35, -8],
  SJS: [37.33, -121.90, -8], STL: [38.63, -90.20, -6], TBL: [27.94, -82.45, -5],
  TOR: [43.64, -79.38, -5], UTA: [40.77, -111.90, -7], VAN: [49.28, -123.11, -8],
  VGK: [36.10, -115.18, -8], WPG: [49.89, -97.14, -6], WSH: [38.90, -77.02, -5],
};

/** Great-circle distance in km between two arenas (0 if unknown). */
export function distanceKm(a, b) {
  const A = ARENAS[a], B = ARENAS[b];
  if (!A || !B || a === b) return 0;
  const rad = Math.PI / 180;
  const dlat = (B[0] - A[0]) * rad, dlon = (B[1] - A[1]) * rad;
  const h = Math.sin(dlat / 2) ** 2 + Math.cos(A[0] * rad) * Math.cos(B[0] * rad) * Math.sin(dlon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

const dayNumber = (date) => Math.round(Date.parse(`${date}T12:00:00Z`) / 86400000);

/**
 * Index games by team: { ab: [{ date, venue, home }] } sorted by date.
 * @param games [{ date, home, away }] (abbrevs)
 */
export function buildSchedule(games) {
  const out = {};
  for (const g of games) {
    (out[g.home] ||= []).push({ date: g.date, venue: g.home, home: true });
    (out[g.away] ||= []).push({ date: g.date, venue: g.home, home: false });
  }
  for (const list of Object.values(out)) list.sort((a, b) => a.date.localeCompare(b.date));
  return out;
}

/**
 * A team's situation going into its game on `date` at `venue`, from games
 * strictly before that date:
 *   restDays      days off since the last game (0 = back-to-back), capped at 3;
 *                 3 when there's no earlier game in the schedule
 *   b2b           played yesterday
 *   threeInFour   this is at least the third game in four days
 *   travelKm      distance from the previous game's arena (from home if none)
 *   tzShift       time zones crossed since the previous game (signed; + = east)
 *   roadTrip      consecutive road games including this one (0 at home)
 *   homeFromTrip  first home game after a road trip of 3+ games
 */
export function scheduleContext(schedule, ab, date, venue) {
  const list = schedule?.[ab] || [];
  const today = dayNumber(date);
  const before = list.filter((g) => g.date < date);
  const last = before[before.length - 1];
  const restDays = last ? Math.min(3, today - dayNumber(last.date) - 1) : 3;
  const recent = before.filter((g) => today - dayNumber(g.date) <= 3);
  const from = last ? last.venue : ab;
  const tz = (v) => ARENAS[v]?.[2] ?? 0;
  const home = venue === ab;
  let roadTrip = 0;
  if (!home) {
    roadTrip = 1;
    for (let i = before.length - 1; i >= 0 && !before[i].home; i--) roadTrip++;
  }
  let tripBefore = 0;
  for (let i = before.length - 1; i >= 0 && !before[i].home; i--) tripBefore++;
  return {
    restDays,
    b2b: restDays === 0,
    threeInFour: recent.length >= 2,
    travelKm: Math.round(distanceKm(from, venue)),
    tzShift: tz(venue) - tz(from),
    roadTrip,
    homeFromTrip: home && tripBefore >= 3,
  };
}

/** Both teams' context for a game ({ date, home, away } abbrevs). */
export function gameContext(schedule, game) {
  return {
    home: scheduleContext(schedule, game.home, game.date, game.home),
    away: scheduleContext(schedule, game.away, game.date, game.home),
  };
}
