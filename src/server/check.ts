import { evaluate, type Signals, type Verdict } from "../verdict";
import { CHAINS, EVM_CHAINS, chainByDexId, detectAddress, type ChainFamily, type ChainKey, type EvmChainKey } from "../chains";
import { thresholds, RPC_URL, CACHE_MS, CHAIN_CACHE_MS, FETCH_TIMEOUT_MS, evmRpcUrls, goplusHeaders } from "./config";
import * as p from "./parse";
import { aiFacts, securityFlags, type Report } from "./report";

export interface SourceStatus { name: string; ok: boolean; url?: string }
export interface PublicResult {
  /** Kept for older clients; same value as address. */
  mint: string;
  address: string;
  chain: { key: ChainKey; name: string; family: ChainFamily };
  name?: string; symbol?: string;
  verdict: Verdict; reasons: string[]; sources: SourceStatus[]; checkedAt: string;
  /** Informational notes that did not affect the verdict. */
  notes?: string[];
  report?: Report;
  /** Short summarized facts for the optional AI explanation. Never used for the verdict. */
  facts?: string[];
}
export type Fetcher = (url: string, init?: RequestInit) => Promise<any>;

/** A real account whose owner is not the Token or Token-2022 program. */
export class NotATokenMintError extends Error {
  constructor() {
    super("That address is not a token mint.");
    this.name = "NotATokenMintError";
  }
}

/** An EVM address with no contract code, or a contract that is not an ERC-20 token. */
export class NotATokenContractError extends Error {
  constructor() {
    super("That address is not a token contract.");
    this.name = "NotATokenContractError";
  }
}

/** The node answered with a JSON-RPC error (for example "execution reverted"). Not a network failure. */
export class RpcReplyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RpcReplyError";
  }
}

const cache = new Map<string, { at: number; result: PublicResult }>();
const chainCache = new Map<string, { at: number; chain: EvmChainKey }>();
const snapshots = new Map<string, number>(); // cache key -> last liquidity USD

async function defaultFetch(url: string, init?: RequestInit) {
  const r = await fetch(url, { ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), headers: { accept: "application/json", ...(init?.headers ?? {}) } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();
  if (j?.error && j?.jsonrpc) throw new RpcReplyError(String(j.error.message ?? "rpc error"));
  if (j?.error) throw new Error(String(j.error.message ?? "rpc error"));
  return j;
}

const rpcBody = (method: string, params: unknown[]) =>
  ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });

const rpc = (f: Fetcher, method: string, params: unknown[]) => f(RPC_URL, rpcBody(method, params));

/** Tries each RPC for the chain. A JSON-RPC error reply (revert) is final and is not retried elsewhere. */
async function evmRpc(f: Fetcher, chain: EvmChainKey, method: string, params: unknown[]): Promise<unknown> {
  let last: unknown = new Error("no rpc");
  for (const url of evmRpcUrls(chain)) {
    try {
      const j = await f(url, rpcBody(method, params));
      if (j?.error) throw new RpcReplyError(String(j.error.message ?? "rpc error"));
      return j?.result;
    } catch (err) {
      if (err instanceof RpcReplyError) throw err;
      last = err;
    }
  }
  throw last;
}

export function _resetForTests() { cache.clear(); snapshots.clear(); chainCache.clear(); }

const goplusUrl = (chain: ChainKey, address: string) => chain === "solana"
  ? `https://api.gopluslabs.io/api/v1/solana/token_security?contract_addresses=${address}`
  : `https://api.gopluslabs.io/api/v1/token_security/${CHAINS[chain].goplusId}?contract_addresses=${address}`;

const dexPairsUrl = (chain: ChainKey, address: string) => `https://api.dexscreener.com/token-pairs/v1/${CHAINS[chain].dexId}/${address}`;

/** Entry point: detects Solana vs EVM from the address. `chain` is an optional EVM chain hint. */
export async function checkToken(input: { address: string; chain?: ChainKey }, f: Fetcher = defaultFetch, now = Date.now()): Promise<PublicResult> {
  const kind = detectAddress(input.address);
  if (kind.kind === "solana") return checkMint(kind.address, f, now);
  if (kind.kind === "evm") return checkEvm(kind.address, input.chain && input.chain !== "solana" ? input.chain : undefined, f, now);
  throw new Error("invalid address");
}

/** Liquidity trend vs the previous check, on total pool liquidity (falls back to the main pool). */
function trend(key: string, s: Signals) {
  const liq = s.totalLiquidityUsd ?? s.liquidityUsd;
  if (liq === undefined) return;
  const prev = snapshots.get(key);
  if (prev !== undefined && prev > 0) s.liquidityDropPct = Math.max(0, (prev - liq) / prev);
  snapshots.set(key, liq);
}

function links(chain: ChainKey, address: string, market: p.MarketInfo | null): Report["links"] {
  const c = CHAINS[chain];
  return {
    explorer: { label: c.explorerName, url: c.explorerToken(address) },
    dexscreener: market && market.pairs > 0 ? `https://dexscreener.com/${c.dexId}/${address}` : undefined,
    websites: market?.websites ?? [],
    socials: market?.socials ?? [],
  };
}

export async function checkMint(mint: string, f: Fetcher = defaultFetch, now = Date.now()): Promise<PublicResult> {
  const key = `solana:${mint}`;
  const hit = cache.get(key);
  if (hit && now - hit.at < CACHE_MS) return hit.result;
  const chain = { key: "solana" as const, name: CHAINS.solana.name, family: "solana" as const };

  const [acct, gecko, dex, rug, gp] = await Promise.allSettled([
    rpc(f, "getAccountInfo", [mint, { encoding: "jsonParsed" }]),
    f(`https://api.geckoterminal.com/api/v2/networks/solana/tokens/${mint}/info`),
    f(dexPairsUrl("solana", mint)),
    f(`https://api.rugcheck.xyz/v1/tokens/${mint}/report/summary`),
    f(goplusUrl("solana", mint), { headers: goplusHeaders() }),
  ]);

  const s: Signals = { chainFamily: "solana", unavailableSources: [] };
  const sources: SourceStatus[] = [];
  const meta: p.TokenMeta = {};
  let gpExtra: p.GoPlusExtra = {};
  let market: p.MarketInfo | null = null;
  const mark = (name: string, ok: boolean, critical = true, url?: string) => { sources.push({ name, ok, ...(url ? { url } : {}) }); if (!ok && critical) s.unavailableSources!.push(name); };

  // Gecko first; on-chain values override authorities.
  try { if (gecko.status !== "fulfilled") throw 0; const g = p.parseGecko(gecko.value); Object.assign(meta, { name: g.name, symbol: g.symbol });
    s.mintAuthorityActive = g.mintAuthorityActive; s.freezeAuthorityActive = g.freezeAuthorityActive; s.honeypot = g.honeypot; s.top10HolderShare = g.top10HolderShare;
    mark("GeckoTerminal", true, true, `https://www.geckoterminal.com/solana/tokens/${mint}`);
  } catch { mark("GeckoTerminal", false); }

  // GoPlus: extra Token-2022 powers, holder count, and a fallback for authorities / concentration. Not critical.
  try { if (gp.status !== "fulfilled") throw 0; const g = p.parseGoPlusSolana(gp.value, mint);
    meta.name ??= g.name; meta.symbol ??= g.symbol;
    s.mintAuthorityActive ??= g.mintAuthorityActive; s.freezeAuthorityActive ??= g.freezeAuthorityActive; s.top10HolderShare ??= g.top10HolderShare;
    s.balanceMutable = g.balanceMutable; s.nonTransferable = g.nonTransferable; s.transferHook = g.transferHook; s.transferFee = g.transferFee;
    gpExtra = g; mark("GoPlus", true, false, `https://gopluslabs.io/token-security/solana/${mint}`);
  } catch { mark("GoPlus", false, false); }

  let supply: bigint | undefined; let decimals: number | undefined;
  try { if (acct.status !== "fulfilled") throw 0; const a = p.parseMintAccount(acct.value);
    if (!a.isMint) {
      if (a.notTokenMint) throw new NotATokenMintError();
      return finish({ mint, address: mint, chain, verdict: "FAIL", reasons: ["No token exists at this address on Solana mainnet."], notes: [], sources: [{ name: "Solana RPC", ok: true }], checkedAt: new Date(now).toISOString() });
    }
    s.mintAuthorityActive = a.mintAuthorityActive; s.freezeAuthorityActive = a.freezeAuthorityActive; supply = a.supply; decimals = a.decimals; mark("Solana RPC", true);
  } catch (err) {
    if (err instanceof NotATokenMintError) throw err;
    mark("Solana RPC", false, s.mintAuthorityActive === undefined);
  }

  // Top holders from RPC only if no other source provided it (public RPC often rate-limits this call).
  if (s.top10HolderShare === undefined && supply !== undefined) {
    try { s.top10HolderShare = p.parseLargestAccounts(await rpc(f, "getTokenLargestAccounts", [mint]), supply); } catch { /* stays unknown */ }
  }

  try { if (dex.status !== "fulfilled") throw 0; market = p.parseDexMarket(dex.value, mint, now);
    const d = p.parseDexScreener(dex.value, now);
    meta.name ??= d.name; meta.symbol ??= d.symbol; s.liquidityUsd = d.liquidityUsd; s.totalLiquidityUsd = d.totalLiquidityUsd; s.poolAgeHours = d.poolAgeHours; s.fdvUsd = d.fdvUsd;
    mark("DexScreener", true, true, `https://dexscreener.com/solana/${mint}`);
  } catch { mark("DexScreener", false); }

  try { if (rug.status !== "fulfilled") throw 0; s.externalDangerFlags = p.parseRugCheck(rug.value); mark("RugCheck", true, false, `https://rugcheck.xyz/tokens/${mint}`); }
  catch { mark("RugCheck", false, false); }

  trend(key, s);

  const v = evaluate(s, thresholds());
  const security = securityFlags(s, "solana", gpExtra);
  const report: Report = {
    token: { decimals, totalSupply: supply !== undefined && decimals !== undefined ? p.formatUnits(supply, decimals) : undefined, trusted: gpExtra.trusted },
    market,
    security,
    holders: { holderCount: gpExtra.holderCount, top10Share: s.top10HolderShare },
    links: links("solana", mint, market),
  };
  return finish({ mint, address: mint, chain, ...meta, ...v, sources, checkedAt: new Date(now).toISOString(), report,
    facts: aiFacts(chain.name, market, s, gpExtra.holderCount, security) });

  function finish(r: PublicResult) { cache.set(key, { at: now, result: r }); return r; }
}

/** Which chain is this 0x address a contract on? DexScreener pools first, then eth_getCode on each chain. */
export async function resolveEvmChain(address: string, hint: EvmChainKey | undefined, f: Fetcher, now = Date.now()): Promise<{ chain: EvmChainKey; codeConfirmed: boolean }> {
  const hasCode = async (chain: EvmChainKey) => {
    const code = await evmRpc(f, chain, "eth_getCode", [address, "latest"]);
    return typeof code === "string" && code !== "0x" && code !== "0x0";
  };
  const confirm = async (chain: EvmChainKey) => {
    try { return (await hasCode(chain)) ? "yes" : "no"; } catch { return "unknown"; }
  };

  if (hint) {
    const c = await confirm(hint);
    if (c === "no") throw new NotATokenContractError();
    return { chain: hint, codeConfirmed: c === "yes" };
  }
  const cached = chainCache.get(address.toLowerCase());
  if (cached && now - cached.at < CHAIN_CACHE_MS) return { chain: cached.chain, codeConfirmed: true };

  let candidates: EvmChainKey[] = [];
  try {
    const liq = p.parseDexSearchChains(await f(`https://api.dexscreener.com/latest/dex/tokens/${address}`), address);
    candidates = Object.entries(liq)
      .map(([dexId, usd]) => [chainByDexId(dexId), usd] as const)
      .filter((x): x is readonly [EvmChainKey, number] => !!x[0] && x[0] !== "solana")
      .sort((a, b) => b[1] - a[1]).map((x) => x[0]);
  } catch { /* fall through to probing */ }

  for (const chain of candidates) {
    const c = await confirm(chain);
    if (c === "no") continue;
    if (c === "yes") chainCache.set(address.toLowerCase(), { at: now, chain });
    return { chain, codeConfirmed: c === "yes" };
  }

  const probes = await Promise.allSettled(EVM_CHAINS.map(hasCode));
  const found = EVM_CHAINS.find((_, i) => probes[i].status === "fulfilled" && (probes[i] as PromiseFulfilledResult<boolean>).value);
  if (found) { chainCache.set(address.toLowerCase(), { at: now, chain: found }); return { chain: found, codeConfirmed: true }; }
  if (probes.every((r) => r.status === "rejected")) throw new Error("all EVM RPCs unavailable");
  throw new NotATokenContractError();
}

export async function checkEvm(address: string, hint: EvmChainKey | undefined, f: Fetcher = defaultFetch, now = Date.now()): Promise<PublicResult> {
  const cacheKeyFor = (c: EvmChainKey) => `${c}:${address.toLowerCase()}`;
  if (hint) { const hit = cache.get(cacheKeyFor(hint)); if (hit && now - hit.at < CACHE_MS) return hit.result; }

  const { chain: chainKey, codeConfirmed } = await resolveEvmChain(address, hint, f, now);
  const key = cacheKeyFor(chainKey);
  const hit = cache.get(key);
  if (hit && now - hit.at < CACHE_MS) return hit.result;
  const c = CHAINS[chainKey];
  const chain = { key: chainKey, name: c.name, family: "evm" as const };

  const call = (data: string) => evmRpc(f, chainKey, "eth_call", [{ to: address, data }, "latest"]);
  const [nameR, symbolR, decimalsR, supplyR, dex, gp] = await Promise.allSettled([
    call(p.SELECTORS.name), call(p.SELECTORS.symbol), call(p.SELECTORS.decimals), call(p.SELECTORS.totalSupply),
    f(dexPairsUrl(chainKey, address)),
    f(goplusUrl(chainKey, address), { headers: goplusHeaders() }),
  ]);

  // ERC-20 check: totalSupply() must answer with a number. A revert or empty answer means this contract is not a token.
  const supply = supplyR.status === "fulfilled" ? p.decodeUint(supplyR.value) : undefined;
  const supplyReverted = supplyR.status === "rejected" && supplyR.reason instanceof RpcReplyError;
  if (supplyReverted || (supplyR.status === "fulfilled" && supply === undefined)) throw new NotATokenContractError();

  const s: Signals = { chainFamily: "evm", unavailableSources: [] };
  const sources: SourceStatus[] = [];
  const meta: p.TokenMeta = {};
  let gpExtra: p.GoPlusExtra = {};
  let market: p.MarketInfo | null = null;
  const mark = (name: string, ok: boolean, critical = true, url?: string) => { sources.push({ name, ok, ...(url ? { url } : {}) }); if (!ok && critical) s.unavailableSources!.push(name); };

  const onchainOk = supplyR.status === "fulfilled" && codeConfirmed;
  const decimals = decimalsR.status === "fulfilled" ? p.decodeUint(decimalsR.value) : undefined;
  meta.name = nameR.status === "fulfilled" ? p.decodeAbiString(nameR.value) : undefined;
  meta.symbol = symbolR.status === "fulfilled" ? p.decodeAbiString(symbolR.value) : undefined;
  mark(`${c.name} RPC`, onchainOk, false, c.explorerToken(address));

  try { if (gp.status !== "fulfilled") throw 0; const g = p.parseGoPlusEvm(gp.value, address);
    meta.name ??= g.name; meta.symbol ??= g.symbol;
    const { name: _n, symbol: _s, holderCount: _h, trusted: _t, listedOnCex: _l, ownerAddress: _o, creatorAddress: _c, metadataMutable: _m, ...signals } = g;
    Object.assign(s, signals, { chainFamily: "evm", unavailableSources: s.unavailableSources });
    gpExtra = g; mark("GoPlus", true, true, `https://gopluslabs.io/token-security/${c.goplusId}/${address}`);
  } catch { mark("GoPlus", false); }

  try { if (dex.status !== "fulfilled") throw 0; market = p.parseDexMarket(dex.value, address, now);
    s.liquidityUsd = market.liquidityUsd; s.totalLiquidityUsd = market.totalLiquidityUsd; s.poolAgeHours = market.poolAgeHours; s.fdvUsd = market.fdvUsd;
    mark("DexScreener", true, true, `https://dexscreener.com/${c.dexId}/${address}`);
  } catch { mark("DexScreener", false); }

  trend(key, s);

  const v = evaluate(s, thresholds());
  const security = securityFlags(s, "evm", gpExtra);
  const dec = decimals !== undefined && decimals <= 77n ? Number(decimals) : undefined;
  const report: Report = {
    token: {
      decimals: dec,
      totalSupply: supply !== undefined && dec !== undefined ? p.formatUnits(supply, dec) : undefined,
      ownerAddress: gpExtra.ownerAddress || undefined, creatorAddress: gpExtra.creatorAddress,
      trusted: gpExtra.trusted, listedOnCex: gpExtra.listedOnCex,
    },
    market,
    security,
    holders: { holderCount: gpExtra.holderCount, top10Share: s.top10HolderShare, creatorShare: s.creatorShare, lpLockedShare: s.lpLockedShare },
    links: links(chainKey, address, market),
  };
  const result: PublicResult = { mint: address, address, chain, ...meta, ...v, sources, checkedAt: new Date(now).toISOString(), report,
    facts: aiFacts(chain.name, market, s, gpExtra.holderCount, security) };
  cache.set(key, { at: now, result });
  return result;
}
