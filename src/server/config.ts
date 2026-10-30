import type { Thresholds } from "../verdict";

/** Server-only. Never import this from client components or send it in responses. */
function num(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && process.env[name] !== "" && process.env[name] !== undefined ? v : fallback;
}

export function thresholds(): Thresholds {
  return {
    minLiquidityUsd: num("RC_MIN_LIQUIDITY_USD", 25_000),
    minPoolAgeHours: num("RC_MIN_POOL_AGE_HOURS", 48),
    maxLiquidityDropPct: num("RC_MAX_LIQUIDITY_DROP", 0.3),
    maxTop10HolderShare: num("RC_MAX_TOP10_SHARE", 0.5),
    warnFdvToLiquidity: num("RC_WARN_FDV_TO_LIQ", 50),
  };
}

export const RPC_URL = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
export const CACHE_MS = 60_000;
export const RATE_LIMIT = { max: num("RC_RATE_MAX", 10), windowMs: 60_000 };
