/** Display helpers shared by the server (AI facts) and the page. */
export function usd(v: number | undefined): string {
  if (v === undefined || !Number.isFinite(v)) return "unavailable";
  if (v !== 0 && Math.abs(v) < 0.01) return `$${v.toPrecision(3)}`;
  if (Math.abs(v) < 1000) return `$${v.toLocaleString("en-US", { maximumFractionDigits: v < 10 ? 4 : 2 })}`;
  return `$${new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 }).format(v)}`;
}

export function pct(v: number | undefined, digits = 1): string {
  if (v === undefined || !Number.isFinite(v)) return "unavailable";
  return `${(v * 100).toFixed(digits).replace(/\.0+$/, "")}%`;
}

export function count(v: number | undefined): string {
  return v === undefined || !Number.isFinite(v) ? "unavailable" : Math.round(v).toLocaleString("en-US");
}

export function age(hours: number | undefined): string {
  if (hours === undefined || !Number.isFinite(hours)) return "unavailable";
  if (hours < 48) return `${Math.max(0, Math.round(hours))} h`;
  const days = hours / 24;
  if (days < 60) return `${Math.round(days)} days`;
  if (days < 730) return `${Math.round(days / 30)} months`;
  return `${(days / 365).toFixed(1).replace(/\.0$/, "")} years`;
}
