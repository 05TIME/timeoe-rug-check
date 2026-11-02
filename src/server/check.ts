import { evaluate, type Signals, type Verdict } from "../verdict";
import { thresholds, RPC_URL, CACHE_MS } from "./config";
import * as p from "./parse";

export interface SourceStatus { name: string; ok: boolean }
export interface PublicResult {
  mint: string; name?: string; symbol?: string;
  verdict: Verdict; reasons: string[]; sources: SourceStatus[]; checkedAt: string;
}
export type Fetcher = (url: string, init?: RequestInit) => Promise<any>;

const cache = new Map<string, { at: number; result: PublicResult }>();
const snapshots = new Map<string, number>(); // mint -> last liquidity USD

async function defaultFetch(url: string, init?: RequestInit) {
  const r = await fetch(url, { ...init, signal: AbortSignal.timeout(8000), headers: { accept: "application/json", ...(init?.headers ?? {}) } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();
  if (j?.error) throw new Error(String(j.error.message ?? "rpc error"));
  return j;
}

const rpc = (f: Fetcher, method: string, params: unknown[]) =>
  f(RPC_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });

export function _resetForTests() { cache.clear(); snapshots.clear(); }

export async function checkMint(mint: string, f: Fetcher = defaultFetch, now = Date.now()): Promise<PublicResult> {
  const hit = cache.get(mint);
  if (hit && now - hit.at < CACHE_MS) return hit.result;

  const [acct, gecko, dex, rug] = await Promise.allSettled([
    rpc(f, "getAccountInfo", [mint, { encoding: "jsonParsed" }]),
    f(`https://api.geckoterminal.com/api/v2/networks/solana/tokens/${mint}/info`),
    f(`https://api.dexscreener.com/token-pairs/v1/solana/${mint}`),
    f(`https://api.rugcheck.xyz/v1/tokens/${mint}/report/summary`),
  ]);

  const s: Signals = { unavailableSources: [] };
  const sources: SourceStatus[] = [];
  const meta: p.TokenMeta = {};
  const mark = (name: string, ok: boolean, critical = true) => { sources.push({ name, ok }); if (!ok && critical) s.unavailableSources!.push(name); };

  // Gecko first; on-chain values override authorities.
  try { if (gecko.status !== "fulfilled") throw 0; const g = p.parseGecko(gecko.value); Object.assign(meta, { name: g.name, symbol: g.symbol });
    s.mintAuthorityActive = g.mintAuthorityActive; s.freezeAuthorityActive = g.freezeAuthorityActive; s.honeypot = g.honeypot; s.top10HolderShare = g.top10HolderShare; mark("GeckoTerminal", true);
  } catch { mark("GeckoTerminal", false); }

  let supply: bigint | undefined;
  try { if (acct.status !== "fulfilled") throw 0; const a = p.parseMintAccount(acct.value);
    if (!a.isMint) { return finish({ mint, verdict: "FAIL", reasons: ["No token exists at this address on Solana mainnet."], sources: [{ name: "Solana RPC", ok: true }], checkedAt: new Date(now).toISOString() }); }
    s.mintAuthorityActive = a.mintAuthorityActive; s.freezeAuthorityActive = a.freezeAuthorityActive; supply = a.supply; mark("Solana RPC", true);
  } catch { mark("Solana RPC", false, s.mintAuthorityActive === undefined); }

  // Top holders from RPC only if Gecko didn't provide it (public RPC often rate-limits this call).
  if (s.top10HolderShare === undefined && supply !== undefined) {
    try { s.top10HolderShare = p.parseLargestAccounts(await rpc(f, "getTokenLargestAccounts", [mint]), supply); } catch { /* stays unknown */ }
  }

  try { if (dex.status !== "fulfilled") throw 0; const d = p.parseDexScreener(dex.value, now);
    meta.name ??= d.name; meta.symbol ??= d.symbol; s.liquidityUsd = d.liquidityUsd; s.poolAgeHours = d.poolAgeHours; s.fdvUsd = d.fdvUsd; mark("DexScreener", true);
  } catch { mark("DexScreener", false); }

  try { if (rug.status !== "fulfilled") throw 0; s.externalDangerFlags = p.parseRugCheck(rug.value); mark("RugCheck", true, false); }
  catch { mark("RugCheck", false, false); }

  if (s.liquidityUsd !== undefined) {
    const prev = snapshots.get(mint);
    if (prev !== undefined && prev > 0) s.liquidityDropPct = Math.max(0, (prev - s.liquidityUsd) / prev);
    snapshots.set(mint, s.liquidityUsd);
  }

  const v = evaluate(s, thresholds());
  return finish({ mint, ...meta, ...v, sources, checkedAt: new Date(now).toISOString() });

  function finish(r: PublicResult) { cache.set(mint, { at: now, result: r }); return r; }
}
