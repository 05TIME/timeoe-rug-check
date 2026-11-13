import type { Thresholds } from "../verdict";
import { CHAINS, type EvmChainKey } from "../chains";

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
    failTax: num("RC_FAIL_TAX", 0.5),
    warnTax: num("RC_WARN_TAX", 0.1),
    maxCreatorShare: num("RC_MAX_CREATOR_SHARE", 0.2),
    minLpLockedShare: num("RC_MIN_LP_LOCKED", 0.5),
    lpLockCheckMaxAgeHours: num("RC_LP_LOCK_MAX_AGE_HOURS", 720),
    deepLiquidityUsd: num("RC_DEEP_LIQUIDITY_USD", 500_000),
    extremeFdvToLiquidity: num("RC_EXTREME_FDV_TO_LIQ", 1000),
  };
}

export const RPC_URL = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
export const CACHE_MS = 60_000;
/** Chain detection for an EVM address rarely changes. */
export const CHAIN_CACHE_MS = 10 * 60_000;
/** Per-request timeout for every external call. */
export const FETCH_TIMEOUT_MS = num("RC_FETCH_TIMEOUT_MS", 7000);

/** Optional per-chain RPC override, e.g. EVM_RPC_URL_ETHEREUM. Falls back to keyless public RPCs. */
export function evmRpcUrls(key: EvmChainKey): string[] {
  const override = process.env[`EVM_RPC_URL_${key.toUpperCase()}`]?.trim();
  return override ? [override, ...CHAINS[key].rpcs] : CHAINS[key].rpcs;
}

/** Optional GoPlus access token (higher rate limits). The public API works without it. */
export function goplusHeaders(): Record<string, string> {
  const token = process.env.GOPLUS_ACCESS_TOKEN?.trim();
  return token ? { authorization: token } : {};
}
export const RATE_LIMIT = { max: num("RC_RATE_MAX", 10), windowMs: 60_000 };
