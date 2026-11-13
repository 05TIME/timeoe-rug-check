/** Builds the report sections and the short AI fact lines from merged signals. Pure. */
import type { Signals } from "../verdict";
import type { ChainFamily } from "../chains";
import type { GoPlusExtra, LinkItem, MarketInfo } from "./parse";
import { age, count, pct, usd } from "../format";

export type FlagState = "ok" | "warn" | "bad" | "unknown";
export interface SecurityFlag { label: string; state: FlagState; detail?: string }

export interface Report {
  token: { decimals?: number; totalSupply?: string; ownerAddress?: string; creatorAddress?: string; trusted?: boolean; listedOnCex?: string[] };
  market: MarketInfo | null;
  security: SecurityFlag[];
  holders: { holderCount?: number; top10Share?: number; creatorShare?: number; lpLockedShare?: number };
  links: { explorer: LinkItem; dexscreener?: string; websites: LinkItem[]; socials: LinkItem[] };
}

const tri = (v: boolean | undefined, badWhenTrue: FlagState, okLabel: string, badLabel: string, unknownLabel: string): SecurityFlag =>
  v === undefined ? { label: unknownLabel, state: "unknown" } : v ? { label: badLabel, state: badWhenTrue } : { label: okLabel, state: "ok" };

const ZERO_OWNER = /^0x0{40}$|^0x0{36}dead$/i;

export function securityFlags(s: Signals, family: ChainFamily, extra: GoPlusExtra = {}): SecurityFlag[] {
  const out: SecurityFlag[] = [];
  if (family === "solana") {
    out.push(tri(s.mintAuthorityActive, "bad", "Mint authority revoked", "Mint authority active", "Mint authority: unknown"));
    out.push(tri(s.freezeAuthorityActive, "bad", "Freeze authority revoked", "Freeze authority active", "Freeze authority: unknown"));
    if (s.balanceMutable !== undefined) out.push(tri(s.balanceMutable, "bad", "Balances cannot be changed by an authority", "An authority can change balances", ""));
    if (s.nonTransferable !== undefined) out.push(tri(s.nonTransferable, "bad", "Transferable", "Non-transferable", ""));
    if (s.transferHook !== undefined) out.push(tri(s.transferHook, "warn", "No transfer hook", "Transfer hook present", ""));
    if (s.defaultAccountFrozen !== undefined) out.push(tri(s.defaultAccountFrozen, "warn", "Accounts not frozen by default", "Accounts start frozen", ""));
    if (s.transferFee !== undefined) out.push(tri(s.transferFee, "warn", "No transfer fee", "Transfer fee present", ""));
    if (extra.metadataMutable !== undefined) out.push(tri(extra.metadataMutable, "warn", "Metadata locked", "Metadata can be changed", ""));
    out.push(tri(s.honeypot, "warn", "Not flagged as honeypot", "Flagged as possible honeypot", "Honeypot: unknown"));
    return out;
  }
  out.push(s.honeypotSimulated === undefined ? { label: "Honeypot simulation: unavailable", state: "unknown" }
    : s.honeypotSimulated ? { label: "Honeypot: cannot sell in simulation", state: "bad" } : { label: "Honeypot simulation: can sell", state: "ok" });
  const tax = (label: string, v: number | undefined): SecurityFlag => v === undefined ? { label: `${label}: unknown`, state: "unknown" }
    : { label: `${label}: ${pct(v)}`, state: v >= 0.5 ? "bad" : v > 0.1 ? "warn" : "ok" };
  out.push(tax("Buy tax", s.buyTax), tax("Sell tax", s.sellTax));
  out.push(tri(s.sourceVerified === undefined ? undefined : !s.sourceVerified, "bad", "Source code verified", "Source code not verified", "Source verification: unknown"));
  if (extra.ownerAddress !== undefined) {
    const renounced = extra.ownerAddress === "" || ZERO_OWNER.test(extra.ownerAddress);
    out.push(renounced ? { label: "No active owner (renounced or none)", state: "ok" } : { label: "Contract has an owner", state: "warn", detail: extra.ownerAddress });
  }
  const opt = (v: boolean | undefined, state: FlagState, ok: string, bad: string) => { if (v !== undefined) out.push(tri(v, state, ok, bad, "")); };
  opt(s.mintable, "warn", "Cannot mint more", "Can mint more tokens");
  opt(s.proxy, "warn", "Not a proxy", "Upgradeable proxy");
  opt(s.blacklist, "warn", "No blacklist", "Can blacklist wallets");
  opt(s.pausable, "warn", "Transfers cannot be paused", "Transfers can be paused");
  opt(s.taxModifiable, "warn", "Tax fixed", "Tax can be changed");
  opt(s.ownerCanChangeBalance, "bad", "Owner cannot change balances", "Owner can change balances");
  opt(s.hiddenOwner, "warn", "No hidden owner", "Hidden owner");
  opt(s.selfDestruct, "bad", "No self-destruct", "Can self-destruct");
  opt(s.canTakeBackOwnership, "warn", "Ownership cannot be reclaimed", "Ownership can be reclaimed");
  opt(s.tradingCooldown, "warn", "No trading cooldown", "Trading cooldown");
  opt(s.cannotSellAll, "warn", "Can sell full balance", "Cannot sell full balance");
  opt(s.cannotBuy, "bad", "Buying allowed", "Buying blocked");
  return out;
}

/** Short fact lines for the AI prompt. Each line is small; the prompt builder enforces the total budget. */
export function aiFacts(chainName: string, m: MarketInfo | null, s: Signals, holderCount: number | undefined, flags: SecurityFlag[]): string[] {
  const facts = [`Chain: ${chainName}`];
  if (m && m.pairs > 0) {
    if (m.priceUsd !== undefined) facts.push(`Price ${usd(m.priceUsd)}${m.priceChange24hPct !== undefined ? ` (${m.priceChange24hPct}% 24h)` : ""}`);
    facts.push(`Liquidity ${usd(m.totalLiquidityUsd ?? m.liquidityUsd)}, 24h volume ${usd(m.volume24hUsd)}`);
    if (m.marketCapUsd !== undefined || m.fdvUsd !== undefined) facts.push(`Market cap ${usd(m.marketCapUsd ?? m.fdvUsd)}`);
    if (m.poolAgeHours !== undefined) facts.push(`Main pool age ${age(m.poolAgeHours)}`);
  } else facts.push("No trading pools found");
  if (holderCount !== undefined) facts.push(`Holders ${count(holderCount)}`);
  if (s.top10HolderShare !== undefined) facts.push(`Top 10 hold ${pct(s.top10HolderShare, 0)}`);
  if (s.buyTax !== undefined || s.sellTax !== undefined) facts.push(`Tax buy ${pct(s.buyTax)} / sell ${pct(s.sellTax)}`);
  const red = flags.filter((f) => f.state === "bad" || f.state === "warn").map((f) => f.label).slice(0, 4);
  if (red.length) facts.push(`Flags: ${red.join("; ")}`);
  return facts;
}
