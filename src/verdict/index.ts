/**
 * Verdict-only package: signals in, PASS / CAUTION / FAIL plus plain reasons out.
 * Pure and dependency-free. Thresholds are injected by the caller (server-side config).
 *
 * Rules (documented in docs/verdict-rules.md; keep both in sync):
 *  FAIL  — any hard red flag (creator can print or freeze on Solana, simulated honeypot,
 *          cannot buy, extreme tax, owner can rewrite balances, self-destruct, unverified
 *          EVM source, non-transferable, low liquidity, very new pool, sharp liquidity drop).
 *  CAUTION — no FAIL but at least one soft flag or unknown signal.
 *  Notes (e.g. first check, no liquidity trend yet) are informational and never change the verdict.
 *  PASS  — every core signal known and clean. Never worded as "safe".
 */
export type Verdict = "PASS" | "CAUTION" | "FAIL";

/** undefined always means "unknown". Unknown is never treated as safe. */
export interface Signals {
  /** Defaults to "solana" so older callers keep their behaviour. */
  chainFamily?: "solana" | "evm";

  // Solana mint authorities (on-chain).
  mintAuthorityActive?: boolean;
  freezeAuthorityActive?: boolean;
  /** Solana: an authority can change balances (GoPlus balance_mutable_authority). */
  balanceMutable?: boolean;
  /** Token-2022 transfer hook or transfer fee present. */
  transferHook?: boolean;
  transferFee?: boolean;
  /** Token-2022 default account state is frozen (new accounts start frozen). */
  defaultAccountFrozen?: boolean;

  /** Heuristic honeypot flag (e.g. GeckoTerminal). Caution only. */
  honeypot?: boolean;
  /** Simulated buy/sell shows the token cannot be sold (GoPlus EVM). FAIL. */
  honeypotSimulated?: boolean;
  cannotBuy?: boolean;
  cannotSellAll?: boolean;
  nonTransferable?: boolean;
  buyTax?: number; // 0..1
  sellTax?: number; // 0..1

  // EVM contract powers (GoPlus).
  sourceVerified?: boolean;
  ownerCanChangeBalance?: boolean;
  selfDestruct?: boolean;
  hiddenOwner?: boolean;
  canTakeBackOwnership?: boolean;
  mintable?: boolean;
  proxy?: boolean;
  blacklist?: boolean;
  pausable?: boolean;
  taxModifiable?: boolean;
  tradingCooldown?: boolean;

  top10HolderShare?: number; // 0..1
  creatorShare?: number; // 0..1
  lpLockedShare?: number; // 0..1 of LP tokens locked or burned (v2-style pools only)

  /** Main (deepest) pool liquidity. Used for the low-liquidity FAIL. */
  liquidityUsd?: number;
  /** Sum of liquidity across all of the token's pools on this chain. Used for the thin-pool CAUTION. */
  totalLiquidityUsd?: number;
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
  /** Buy or sell tax at or above this is a FAIL. Default 0.5. */
  failTax?: number;
  /** Buy or sell tax above this is a CAUTION. Default 0.1. */
  warnTax?: number;
  /** Creator wallet share above this is a CAUTION. Default 0.2. */
  maxCreatorShare?: number;
  /** LP locked/burned share below this is a CAUTION while the pool is young. Default 0.5. */
  minLpLockedShare?: number;
  /** Pools younger than this many hours get the unlocked-LP caution. Default 720 (30 days). */
  lpLockCheckMaxAgeHours?: number;
  /** Total pool liquidity at or above this is deep enough that the FDV/liquidity ratio alone is not a caution. Default 500,000. */
  deepLiquidityUsd?: number;
  /** FDV / total liquidity above this is a caution even when liquidity is deep. Default 1,000. */
  extremeFdvToLiquidity?: number;
}

export interface VerdictResult {
  verdict: Verdict;
  reasons: string[];
  /** Informational context. Never affects the verdict. */
  notes: string[];
}

const MAX_REASONS = 6;

/** Solana: freeze authority revoked, no transfer hook, transferable, no balance-changing authority, accounts not frozen by default. All must be known. */
export function solanaSellPathClean(s: Signals): boolean {
  return s.freezeAuthorityActive === false && s.transferHook === false && s.nonTransferable === false
    && s.balanceMutable === false && s.defaultAccountFrozen === false;
}

export function evaluate(s: Signals, t: Thresholds): VerdictResult {
  const fails: string[] = [];
  const cautions: string[] = [];
  const notes: string[] = [];
  const evm = s.chainFamily === "evm";
  const failTax = t.failTax ?? 0.5;
  const warnTax = t.warnTax ?? 0.1;

  if (!evm) {
    if (s.mintAuthorityActive === true) fails.push("Mint authority is still active, so the creator can print more tokens.");
    else if (s.mintAuthorityActive === undefined) cautions.push("Could not confirm whether the mint authority is revoked.");

    if (s.freezeAuthorityActive === true) fails.push("Freeze authority is active, so the issuer can freeze anyone's tokens. Regulated stablecoins do this; meme tokens should not.");
    else if (s.freezeAuthorityActive === undefined) cautions.push("Could not confirm whether the freeze authority is revoked.");

    if (s.balanceMutable === true) fails.push("An authority can change token balances in holders' wallets.");
    if (s.transferHook === true) cautions.push("The token runs custom code on every transfer (transfer hook).");
    if (s.transferFee === true) cautions.push("The token charges a fee on every transfer.");
  }

  // Simulated honeypot (GoPlus EVM) is a hard fail; heuristic flags stay a caution.
  if (s.honeypotSimulated === true) fails.push("A buy-and-sell simulation shows this token cannot be sold (honeypot).");
  else if (s.honeypot === true) cautions.push("A data source flags this as a possible honeypot: you may not be able to sell. Test with a tiny amount first.");
  else if (s.honeypot === undefined && s.honeypotSimulated === undefined) {
    // Solana has no buy/sell simulation. When every on-chain way to block a sale is known to be off, the
    // missing heuristic flag is informational only. Any of these unknown or on keeps the caution.
    if (!evm && solanaSellPathClean(s)) notes.push("No honeypot test exists for Solana tokens; freeze authority, transfer hook, transfer blocks and balance control are all clear.");
    else cautions.push("Honeypot status is unknown.");
  }
  if (!evm && s.defaultAccountFrozen === true) cautions.push("New token accounts start frozen, so the issuer must unfreeze wallets before they can move tokens.");

  if (s.cannotBuy === true) fails.push("The contract blocks buying.");
  if (s.nonTransferable === true) fails.push("The token cannot be transferred, so it cannot be sold.");
  if (s.cannotSellAll === true) cautions.push("Holders cannot sell their whole balance at once.");

  const maxTax = Math.max(s.buyTax ?? 0, s.sellTax ?? 0);
  if (maxTax >= failTax) fails.push("Buy or sell tax is extreme, so most of each trade is taken by the contract.");
  else if (maxTax > warnTax) cautions.push("Buy or sell tax is high.");

  if (evm) {
    if (s.sourceVerified === false) fails.push("The contract source code is not verified, so what it does cannot be checked.");
    if (s.ownerCanChangeBalance === true) fails.push("The owner can change holders' balances.");
    if (s.selfDestruct === true) fails.push("The contract can self-destruct.");
    if (s.hiddenOwner === true) cautions.push("The contract has a hidden owner.");
    if (s.canTakeBackOwnership === true) cautions.push("Ownership can be reclaimed after being renounced.");
    if (s.mintable === true) cautions.push("The contract can mint more tokens. Stablecoins and governance tokens often can; new meme tokens should not.");
    if (s.blacklist === true) cautions.push("The contract can blacklist wallets from trading.");
    if (s.pausable === true) cautions.push("Transfers can be paused by the owner.");
    if (s.proxy === true) cautions.push("This is an upgradeable proxy, so the code can be changed later.");
    if (s.taxModifiable === true) cautions.push("The owner can change the trading tax.");
    if (s.tradingCooldown === true) cautions.push("The contract enforces a trading cooldown.");
  }

  if (s.top10HolderShare === undefined) cautions.push("Holder concentration is unknown.");
  // Top-holder lists include exchange and pool wallets, so high concentration is a caution, not a hard fail.
  else if (s.top10HolderShare > t.maxTop10HolderShare) cautions.push("A small group of wallets holds a very large share of the supply (this can include exchange and pool wallets).");

  if (s.creatorShare !== undefined && s.creatorShare > (t.maxCreatorShare ?? 0.2))
    cautions.push("The creator wallet still holds a large share of the supply.");

  if (s.liquidityUsd === undefined) cautions.push("No trading pool liquidity was found.");
  else if (s.liquidityUsd < t.minLiquidityUsd) fails.push("Pool liquidity is low, so the price can be moved or drained easily.");

  if (s.poolAgeHours === undefined) cautions.push("Pool age is unknown.");
  else if (s.poolAgeHours < t.minPoolAgeHours) fails.push("The trading pool is very new.");

  if (s.lpLockedShare !== undefined && s.lpLockedShare < (t.minLpLockedShare ?? 0.5)
    && s.poolAgeHours !== undefined && s.poolAgeHours < (t.lpLockCheckMaxAgeHours ?? 720))
    cautions.push("Most pool liquidity is not locked or burned, so it could be pulled.");

  // First check: no earlier snapshot to compare. Informational only; a real drop is still a FAIL.
  if (s.liquidityDropPct === undefined) notes.push("Liquidity trend not tracked yet (first check). A sharp drop on a later check is a fail.");
  else if (s.liquidityDropPct > t.maxLiquidityDropPct) fails.push("Liquidity has dropped sharply since the last check.");

  // Thin pool: valuation vs liquidity summed across all pools. Deep total liquidity only trips it at an extreme ratio,
  // because large tokens trade mostly on exchanges and their on-chain pools are small next to their valuation.
  const poolLiq = s.totalLiquidityUsd ?? s.liquidityUsd;
  if (s.fdvUsd !== undefined && poolLiq) {
    const ratio = s.fdvUsd / poolLiq;
    const deep = poolLiq >= (t.deepLiquidityUsd ?? 500_000);
    if (deep ? ratio > (t.extremeFdvToLiquidity ?? 1000) : ratio > t.warnFdvToLiquidity)
      cautions.push("Pool liquidity is thin compared with the token's valuation.");
  }

  for (const f of s.externalDangerFlags ?? []) cautions.push(`Second-opinion source flags: ${f}.`);
  for (const src of s.unavailableSources ?? []) cautions.push(`${src} was unavailable, so this check is incomplete.`);

  const verdict: Verdict = fails.length ? "FAIL" : cautions.length ? "CAUTION" : "PASS";
  const reasons = verdict === "PASS"
    ? ["No red flags found in the data available. This does not mean the token is safe."]
    : [...fails, ...cautions].slice(0, MAX_REASONS);
  return { verdict, reasons, notes };
}
