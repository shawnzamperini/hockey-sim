// Primary team colors, used for the logo fallback badge when a logo can't load
// (e.g. offline before logos have been cached).
export const TEAM_COLORS = {
  ANA: "#F47A38", BOS: "#2B2B2B", BUF: "#003087", CGY: "#C8102E",
  CAR: "#CE1126", CHI: "#CF0A2C", COL: "#6F263D", CBJ: "#002654",
  DAL: "#006847", DET: "#CE1126", EDM: "#041E42", FLA: "#C8102E",
  LAK: "#111111", MIN: "#154734", MTL: "#AF1E2D", NSH: "#C7951B",
  NJD: "#CE1126", NYI: "#00539B", NYR: "#0038A8", OTT: "#DA1A32",
  PHI: "#F74902", PIT: "#1D1D1D", SJS: "#006D75", SEA: "#001628",
  STL: "#002F87", TBL: "#002868", TOR: "#00205B", UTA: "#3F7FB5",
  VAN: "#00205B", VGK: "#8A7340", WSH: "#C8102E", WPG: "#041E42",
};

export function teamColor(abbrev) {
  return TEAM_COLORS[abbrev] || "#5E6F82";
}
