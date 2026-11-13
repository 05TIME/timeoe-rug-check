/** Pure parsers for source responses (fixture-tested). Each returns partial signals. */
import type { Signals } from "../verdict";

export interface TokenMeta { name?: string; symbol?: string }

/** SPL Token and Token-2022. Anything else at a real account is not a mint. */
export const TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const TOKEN_2022_PROGRAM_ID = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

export function isTokenProgram(owner: unknown): boolean {
  return owner === TOKEN_PROGRAM_ID || owner === TOKEN_2022_PROGRAM_ID;
}

export function parseMintAccount(json: any): (Partial<Signals> & { supply?: bigint; decimals?: number; isMint: boolean; notTokenMint?: boolean }) {
  const v = json?.result?.value;
  if (v === null) return { isMint: false };
  const owner = v?.owner;
  const parsed = v?.data?.parsed;
  if (typeof owner === "string" && !isTokenProgram(owner)) return { isMint: false, notTokenMint: true };
  if (isTokenProgram(owner) && (!parsed || parsed.type !== "mint")) return { isMint: false, notTokenMint: true };
  if (!parsed || parsed.type !== "mint") throw new Error("not a mint");
  const info = parsed.info;
  return {
    isMint: true,
    mintAuthorityActive: info.mintAuthority != null,
    freezeAuthorityActive: info.freezeAuthority != null,
    supply: BigInt(info.supply),
    decimals: typeof info.decimals === "number" ? info.decimals : undefined,
  };
}

export function parseLargestAccounts(json: any, supply: bigint): number | undefined {
  const list = json?.result?.value;
  if (!Array.isArray(list) || supply === 0n) return undefined;
  const top = list.slice(0, 10).reduce((a: bigint, x: any) => a + BigInt(x.amount), 0n);
  return Number((top * 1_000_000n) / supply) / 1_000_000;
}

const yn = (v: unknown) => (v === "yes" ? true : v === "no" ? false : undefined);

export function parseGecko(json: any): Partial<Signals> & TokenMeta {
  const a = json?.data?.attributes;
  if (!a) throw new Error("no attributes");
  const top = Number(a.holders?.distribution_percentage?.top_10);
  return {
    name: a.name, symbol: a.symbol,
    mintAuthorityActive: yn(a.mint_authority),
    freezeAuthorityActive: yn(a.freeze_authority),
    honeypot: yn(a.is_honeypot),
    top10HolderShare: Number.isFinite(top) && a.holders?.distribution_percentage?.top_10 != null ? top / 100 : undefined,
  };
}

/** Sum of pool liquidity in USD; undefined when no pool reports it. */
export function totalLiquidity(pairs: any[]): number | undefined {
  const vals = pairs.map((p) => p?.liquidity?.usd).filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  return vals.length ? vals.reduce((a, b) => a + b, 0) : undefined;
}

/** Uses the deepest pool for liquidity / age / FDV. */
export function parseDexScreener(json: any, nowMs: number): Partial<Signals> & TokenMeta & { pairs: number } {
  if (!Array.isArray(json)) throw new Error("bad response");
  const best = [...json].sort((x, y) => (y?.liquidity?.usd ?? 0) - (x?.liquidity?.usd ?? 0))[0];
  if (!best) return { pairs: 0 };
  return {
    pairs: json.length,
    name: best.baseToken?.name, symbol: best.baseToken?.symbol,
    liquidityUsd: typeof best.liquidity?.usd === "number" ? best.liquidity.usd : undefined,
    totalLiquidityUsd: totalLiquidity(json),
    poolAgeHours: typeof best.pairCreatedAt === "number" ? (nowMs - best.pairCreatedAt) / 3_600_000 : undefined,
    fdvUsd: typeof best.fdv === "number" ? best.fdv : undefined,
  };
}

export function parseRugCheck(json: any): string[] {
  if (!Array.isArray(json?.risks)) throw new Error("bad response");
  return json.risks.filter((r: any) => r?.level === "danger" && typeof r.name === "string").map((r: any) => r.name);
}

// ---------------------------------------------------------------------------
// Market data (DexScreener) — richer report fields.

export interface LinkItem { label: string; url: string }
export interface MarketInfo {
  pairs: number;
  /** Sum of liquidity over every pool returned for this token on this chain (DexScreener returns up to 30). */
  totalLiquidityUsd?: number;
  priceUsd?: number;
  priceChange24hPct?: number;
  liquidityUsd?: number;
  volume24hUsd?: number;
  fdvUsd?: number;
  marketCapUsd?: number;
  poolAgeHours?: number;
  pairCreatedAt?: string;
  dex?: string;
  quoteSymbol?: string;
  pairUrl?: string;
  buys24h?: number;
  sells24h?: number;
  websites: LinkItem[];
  socials: LinkItem[];
}

const num = (v: unknown): number | undefined => {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : undefined;
};

/** Only plain http(s) links reach the page. */
export function safeUrl(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  try {
    const u = new URL(v);
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : undefined;
  } catch { return undefined; }
}

const sameAddr = (a: unknown, b: string) => typeof a === "string" && a.toLowerCase() === b.toLowerCase();

/**
 * Market summary from DexScreener pairs. Uses the deepest pool where this token is the base
 * token (so price is this token's price), falling back to the deepest pool overall.
 */
export function parseDexMarket(json: any, address: string, nowMs: number): MarketInfo {
  const list = Array.isArray(json) ? json : Array.isArray(json?.pairs) ? json.pairs : json?.pairs === null ? [] : null;
  if (!list) throw new Error("bad response");
  const byLiq = [...list].sort((x: any, y: any) => (y?.liquidity?.usd ?? 0) - (x?.liquidity?.usd ?? 0));
  const best = byLiq.find((p: any) => sameAddr(p?.baseToken?.address, address)) ?? byLiq[0];
  if (!best) return { pairs: 0, websites: [], socials: [] };
  const asBase = sameAddr(best.baseToken?.address, address);
  const websites: LinkItem[] = []; const socials: LinkItem[] = [];
  for (const p of byLiq) {
    for (const w of p?.info?.websites ?? []) { const url = safeUrl(w?.url); if (url && !websites.some((x) => x.url === url)) websites.push({ label: String(w.label ?? "Website").slice(0, 40), url }); }
    for (const s of p?.info?.socials ?? []) { const url = safeUrl(s?.url); if (url && !socials.some((x) => x.url === url)) socials.push({ label: String(s.type ?? "Social").slice(0, 40), url }); }
  }
  const created = num(best.pairCreatedAt);
  return {
    pairs: list.length,
    totalLiquidityUsd: totalLiquidity(list),
    priceUsd: asBase ? num(best.priceUsd) : undefined,
    priceChange24hPct: asBase ? num(best.priceChange?.h24) : undefined,
    liquidityUsd: num(best.liquidity?.usd),
    volume24hUsd: num(best.volume?.h24),
    fdvUsd: asBase ? num(best.fdv) : undefined,
    marketCapUsd: asBase ? num(best.marketCap) : undefined,
    poolAgeHours: created !== undefined ? (nowMs - created) / 3_600_000 : undefined,
    pairCreatedAt: created !== undefined ? new Date(created).toISOString() : undefined,
    dex: typeof best.dexId === "string" ? best.dexId : undefined,
    quoteSymbol: asBase ? best.quoteToken?.symbol : best.baseToken?.symbol,
    pairUrl: safeUrl(best.url),
    buys24h: num(best.txns?.h24?.buys),
    sells24h: num(best.txns?.h24?.sells),
    websites: websites.slice(0, 4),
    socials: socials.slice(0, 6),
  };
}

/** DexScreener /latest/dex/tokens search -> total liquidity per DexScreener chainId for pools that include this token. */
export function parseDexSearchChains(json: any, address: string): Record<string, number> {
  const pairs = json?.pairs;
  if (pairs === null) return {};
  if (!Array.isArray(pairs)) throw new Error("bad response");
  const out: Record<string, number> = {};
  for (const p of pairs) {
    if (!sameAddr(p?.baseToken?.address, address) && !sameAddr(p?.quoteToken?.address, address)) continue;
    if (typeof p?.chainId !== "string") continue;
    out[p.chainId] = (out[p.chainId] ?? 0) + (num(p?.liquidity?.usd) ?? 0);
  }
  return out;
}

// ---------------------------------------------------------------------------
// GoPlus token_security.

const flag = (v: unknown): boolean | undefined => (v === "1" || v === 1 ? true : v === "0" || v === 0 ? false : undefined);
const DEAD = new Set(["0x000000000000000000000000000000000000dead", "0x0000000000000000000000000000000000000000"]);

function pickResult(json: any, address: string): any {
  if (json?.code !== 1 || !json?.result || typeof json.result !== "object") throw new Error(`goplus: ${json?.message ?? "bad response"}`);
  const key = Object.keys(json.result).find((k) => k.toLowerCase() === address.toLowerCase());
  const r = key ? json.result[key] : undefined;
  if (!r || typeof r !== "object" || Object.keys(r).length === 0) throw new Error("goplus: token not indexed");
  return r;
}

function topShare(holders: any): number | undefined {
  if (!Array.isArray(holders) || holders.length === 0) return undefined;
  const sum = holders.slice(0, 10).reduce((a: number, h: any) => a + (num(h?.percent) ?? 0), 0);
  return Math.min(1, sum);
}

export interface GoPlusExtra {
  holderCount?: number;
  name?: string;
  symbol?: string;
  trusted?: boolean;
  listedOnCex?: string[];
  ownerAddress?: string;
  creatorAddress?: string;
  metadataMutable?: boolean;
}

export function parseGoPlusEvm(json: any, address: string): Partial<Signals> & GoPlusExtra {
  const r = pickResult(json, address);
  const lp = Array.isArray(r.lp_holders) ? r.lp_holders : [];
  const lpLocked = lp.length
    ? Math.min(1, lp.reduce((a: number, h: any) => a + ((h?.is_locked === 1 || DEAD.has(String(h?.address).toLowerCase())) ? (num(h?.percent) ?? 0) : 0), 0))
    : undefined;
  const owner = typeof r.owner_address === "string" ? r.owner_address : undefined;
  return {
    chainFamily: "evm",
    name: r.token_name, symbol: r.token_symbol,
    honeypotSimulated: flag(r.is_honeypot),
    cannotBuy: flag(r.cannot_buy),
    cannotSellAll: flag(r.cannot_sell_all),
    buyTax: num(r.buy_tax), sellTax: num(r.sell_tax),
    sourceVerified: flag(r.is_open_source),
    ownerCanChangeBalance: flag(r.owner_change_balance),
    selfDestruct: flag(r.selfdestruct),
    hiddenOwner: flag(r.hidden_owner),
    canTakeBackOwnership: flag(r.can_take_back_ownership),
    mintable: flag(r.is_mintable),
    proxy: flag(r.is_proxy),
    blacklist: flag(r.is_blacklisted),
    pausable: flag(r.transfer_pausable),
    taxModifiable: flag(r.slippage_modifiable) === true || flag(r.personal_slippage_modifiable) === true ? true
      : flag(r.slippage_modifiable) === false ? false : undefined,
    tradingCooldown: flag(r.trading_cooldown),
    top10HolderShare: topShare(r.holders),
    creatorShare: num(r.creator_percent),
    lpLockedShare: lpLocked,
    holderCount: num(r.holder_count),
    trusted: flag(r.trust_list),
    listedOnCex: Array.isArray(r.is_in_cex?.cex_list) ? r.is_in_cex.cex_list.filter((x: unknown) => typeof x === "string").slice(0, 6) : undefined,
    ownerAddress: owner,
    creatorAddress: typeof r.creator_address === "string" ? r.creator_address : undefined,
  };
}

const status = (o: any): boolean | undefined => flag(o?.status);

export function parseGoPlusSolana(json: any, address: string): Partial<Signals> & GoPlusExtra {
  const r = pickResult(json, address);
  const fee = r.transfer_fee;
  return {
    name: r.metadata?.name, symbol: r.metadata?.symbol,
    mintAuthorityActive: status(r.mintable),
    freezeAuthorityActive: status(r.freezable),
    balanceMutable: status(r.balance_mutable_authority),
    nonTransferable: flag(r.non_transferable),
    transferHook: Array.isArray(r.transfer_hook) ? r.transfer_hook.length > 0 : undefined,
    transferFee: fee && typeof fee === "object" ? Object.keys(fee).length > 0 : undefined,
    // SPL AccountState: 1 = initialized, 2 = frozen.
    defaultAccountFrozen: r.default_account_state === "2" || r.default_account_state === 2 ? true
      : r.default_account_state === "1" || r.default_account_state === 1 ? false : undefined,
    metadataMutable: status(r.metadata_mutable),
    top10HolderShare: topShare(r.holders),
    holderCount: num(r.holder_count),
    trusted: flag(r.trusted_token),
  };
}

// ---------------------------------------------------------------------------
// ERC-20 ABI decoding for eth_call results.

export const SELECTORS = { name: "0x06fdde03", symbol: "0x95d89b41", decimals: "0x313ce567", totalSupply: "0x18160ddd" } as const;

const hexBody = (v: unknown): string | undefined => (typeof v === "string" && /^0x[0-9a-fA-F]*$/.test(v) ? v.slice(2) : undefined);

export function decodeUint(v: unknown): bigint | undefined {
  const h = hexBody(v);
  if (!h || h.length < 64) return undefined;
  return BigInt(`0x${h.slice(0, 64)}`);
}

/** ABI string, or a bytes32 string (older tokens like MKR). */
export function decodeAbiString(v: unknown): string | undefined {
  const h = hexBody(v);
  if (!h) return undefined;
  const utf8 = (hex: string) => Buffer.from(hex, "hex").toString("utf8").replace(/\u0000+$/g, "").replace(/[\u0000-\u001f]/g, "").trim();
  if (h.length >= 128) {
    const offset = Number(BigInt(`0x${h.slice(0, 64)}`));
    if (offset === 32) {
      const len = Number(BigInt(`0x${h.slice(64, 128)}`));
      if (len <= 256 && h.length >= 128 + len * 2) return utf8(h.slice(128, 128 + len * 2)) || undefined;
    }
  }
  if (h.length === 64) return utf8(h) || undefined;
  return undefined;
}

/** 1234567891234n, 6 -> "1,234,567.891234" trimmed to at most 4 decimals. */
export function formatUnits(raw: bigint, decimals: number): string {
  const d = BigInt(10) ** BigInt(Math.max(0, Math.min(36, decimals)));
  const whole = raw / d;
  let frac = decimals > 0 ? (raw % d).toString().padStart(decimals, "0").slice(0, 4).replace(/0+$/, "") : "";
  const w = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return frac ? `${w}.${frac}` : w;
}
