/**
 * Verdict-only package: signals in, PASS / CAUTION / FAIL plus plain reasons out.
 * Pure and dependency-free. Thresholds are injected by the caller (server-side config).
 */
export type Verdict = "PASS" | "CAUTION" | "FAIL";

/** undefined always means "unknown". Unknown is never treated as safe. */
export interface Signals {
  mintAuthorityActive?: boolean;
  freezeAuthorityActive?: boolean;
  honeypot?: boolean;
  top10HolderShare?: number; // 0..1
  liquidityUsd?: number;
  poolAgeHours?: number;
  liquidityDropPct?: number; // 0..1 vs previous snapshot; undefined = trend unknown
  fdvUsd?: number;
  externalDangerFlags?: string[]; // plain names of danger-level risks from a second-opinion source
  unavailableSources?: string[];
}

export interface Thresholds {
  minLiquidityUsd: number;
  minPoolAgeHours: number;
  maxLiquidityDropPct: number;
  maxTop10HolderShare: number;
  warnFdvToLiquidity: number;
}

export interface VerdictResult {
  verdict: Verdict;
  reasons: string[];
}

const MAX_REASONS = 6;

export function evaluate(s: Signals, t: Thresholds): VerdictResult {
  const fails: string[] = [];
  const cautions: string[] = [];

  if (s.mintAuthorityActive === true) fails.push("Mint authority is still active, so the creator can print more tokens.");
  else if (s.mintAuthorityActive === undefined) cautions.push("Could not confirm whether the mint authority is revoked.");

  if (s.freezeAuthorityActive === true) fails.push("Freeze authority is active, so the issuer can freeze anyone's tokens. Regulated stablecoins do this; meme tokens should not.");
  else if (s.freezeAuthorityActive === undefined) cautions.push("Could not confirm whether the freeze authority is revoked.");

  // Honeypot flags come from third-party heuristics and are often missing or wrong, so a flag is a caution, not a hard fail.
  if (s.honeypot === true) cautions.push("A data source flags this as a possible honeypot: you may not be able to sell. Test with a tiny amount first.");
  else if (s.honeypot === undefined) cautions.push("Honeypot status is unknown.");

  if (s.top10HolderShare === undefined) cautions.push("Holder concentration is unknown.");
  // Top-holder lists include exchange and pool wallets, so high concentration is a caution, not a hard fail.
  else if (s.top10HolderShare > t.maxTop10HolderShare) cautions.push("A small group of wallets holds a very large share of the supply (this can include exchange and pool wallets).");

  if (s.liquidityUsd === undefined) cautions.push("No trading pool liquidity was found.");
  else if (s.liquidityUsd < t.minLiquidityUsd) fails.push("Pool liquidity is low, so the price can be moved or drained easily.");

  if (s.poolAgeHours === undefined) cautions.push("Pool age is unknown.");
  else if (s.poolAgeHours < t.minPoolAgeHours) fails.push("The trading pool is very new.");

  if (s.liquidityDropPct === undefined) cautions.push("Liquidity trend unknown (no earlier snapshot yet).");
  else if (s.liquidityDropPct > t.maxLiquidityDropPct) fails.push("Liquidity has dropped sharply since the last check.");

  if (s.fdvUsd !== undefined && s.liquidityUsd && s.fdvUsd / s.liquidityUsd > t.warnFdvToLiquidity)
    cautions.push("The pool is thin compared with the token's valuation.");

  for (const f of s.externalDangerFlags ?? []) cautions.push(`Second-opinion source flags: ${f}.`);
  for (const src of s.unavailableSources ?? []) cautions.push(`${src} was unavailable, so this check is incomplete.`);

  const verdict: Verdict = fails.length ? "FAIL" : cautions.length ? "CAUTION" : "PASS";
  const reasons = verdict === "PASS"
    ? ["No red flags found in the data available. This does not mean the token is safe."]
    : [...fails, ...cautions].slice(0, MAX_REASONS);
  return { verdict, reasons };
}
