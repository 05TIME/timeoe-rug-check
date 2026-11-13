/** Pure parsers for source responses (fixture-tested). Each returns partial signals. */
import type { Signals } from "../verdict";

export interface TokenMeta { name?: string; symbol?: string }

/** SPL Token and Token-2022. Anything else at a real account is not a mint. */
export const TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const TOKEN_2022_PROGRAM_ID = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

export function isTokenProgram(owner: unknown): boolean {
  return owner === TOKEN_PROGRAM_ID || owner === TOKEN_2022_PROGRAM_ID;
}

export function parseMintAccount(json: any): (Partial<Signals> & { supply?: bigint; isMint: boolean; notTokenMint?: boolean }) {
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

/** Uses the deepest pool for liquidity / age / FDV. */
export function parseDexScreener(json: any, nowMs: number): Partial<Signals> & TokenMeta & { pairs: number } {
  if (!Array.isArray(json)) throw new Error("bad response");
  const best = [...json].sort((x, y) => (y?.liquidity?.usd ?? 0) - (x?.liquidity?.usd ?? 0))[0];
  if (!best) return { pairs: 0 };
  return {
    pairs: json.length,
    name: best.baseToken?.name, symbol: best.baseToken?.symbol,
    liquidityUsd: typeof best.liquidity?.usd === "number" ? best.liquidity.usd : undefined,
    poolAgeHours: typeof best.pairCreatedAt === "number" ? (nowMs - best.pairCreatedAt) / 3_600_000 : undefined,
    fdvUsd: typeof best.fdv === "number" ? best.fdv : undefined,
  };
}

export function parseRugCheck(json: any): string[] {
  if (!Array.isArray(json?.risks)) throw new Error("bad response");
  return json.risks.filter((r: any) => r?.level === "danger" && typeof r.name === "string").map((r: any) => r.name);
}
