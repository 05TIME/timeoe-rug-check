# Verdict rules

The verdict is computed only by `src/verdict/index.ts` from fetched signals. The AI explanation never changes it.
`undefined` means unknown, and unknown is never treated as safe. Reason text never contains threshold numbers.
Thresholds can be tuned with the `RC_*` env vars in `src/server/config.ts` (defaults shown).

**FAIL** if any of these is true. **CAUTION** if no FAIL but any caution applies. **PASS** only when nothing applies.

| Signal | Chains | Source | Result |
|---|---|---|---|
| Mint authority active | Solana | Solana RPC (overrides GeckoTerminal / GoPlus) | FAIL (unknown: CAUTION) |
| Freeze authority active | Solana | Solana RPC | FAIL (unknown: CAUTION) |
| Authority can change balances | Solana | GoPlus `balance_mutable_authority` | FAIL |
| Transfer hook / transfer fee (Token-2022) | Solana | GoPlus | CAUTION |
| Honeypot in buy/sell simulation | EVM | GoPlus `is_honeypot` | FAIL |
| Possible honeypot (heuristic) | Solana | GeckoTerminal `is_honeypot` | CAUTION |
| Honeypot status unknown | EVM | — | CAUTION |
| Honeypot status unknown | Solana | — | **Note only** when every sell-blocking check is known and clear: freeze authority revoked, no transfer hook, transferable, no balance-changing authority, accounts not frozen by default. If any of these is on or unavailable: CAUTION |
| Accounts start frozen (Token-2022 default account state) | Solana | GoPlus `default_account_state` | CAUTION |
| Buying blocked | EVM | GoPlus `cannot_buy` | FAIL |
| Non-transferable | all | GoPlus | FAIL |
| Buy or sell tax ≥ 50% (`RC_FAIL_TAX`) | EVM | GoPlus | FAIL |
| Buy or sell tax > 10% (`RC_WARN_TAX`) | EVM | GoPlus | CAUTION |
| Cannot sell full balance | EVM | GoPlus | CAUTION |
| Source not verified | EVM | GoPlus `is_open_source` | FAIL |
| Owner can change balances | EVM | GoPlus `owner_change_balance` | FAIL |
| Self-destruct | EVM | GoPlus `selfdestruct` | FAIL |
| Hidden owner, reclaimable ownership, mintable, proxy, blacklist, pausable, modifiable tax, trading cooldown | EVM | GoPlus | CAUTION each |
| Top-10 holders > 50% (`RC_MAX_TOP10_SHARE`) | all | GeckoTerminal → GoPlus → RPC | CAUTION (unknown: CAUTION) |
| Creator holds > 20% (`RC_MAX_CREATOR_SHARE`) | EVM | GoPlus | CAUTION |
| Main-pool liquidity < $25k (`RC_MIN_LIQUIDITY_USD`) | all | DexScreener | FAIL (none found: CAUTION) |
| Main pool < 48 h old (`RC_MIN_POOL_AGE_HOURS`) | all | DexScreener | FAIL (unknown: CAUTION) |
| LP locked/burned < 50% while pool < 30 days (`RC_MIN_LP_LOCKED`, `RC_LP_LOCK_MAX_AGE_HOURS`) | EVM v2-style pools | GoPlus `lp_holders` | CAUTION |
| Total liquidity dropped > 30% since last check (`RC_MAX_LIQUIDITY_DROP`) | all | in-memory snapshot | FAIL (first check, no snapshot: **note only**, no effect on the verdict) |
| Thin pools: FDV / **total** liquidity across all of the token's pools > 50 (`RC_WARN_FDV_TO_LIQ`) while total liquidity < $500k (`RC_DEEP_LIQUIDITY_USD`); or > 1,000 (`RC_EXTREME_FDV_TO_LIQ`) at any depth | all | DexScreener (sum of up to 30 pools on that chain) | CAUTION |
| RugCheck danger-level risk | Solana | RugCheck.xyz | CAUTION each |
| A critical source unavailable | all | — | CAUTION |

Why the thin-pool rule has two tiers: large tokens trade mostly on centralized exchanges, so their on-chain pools are
small next to their valuation (live on 2026-11-13: USDC ≈ 210×, Bonk ≈ 230×, ARB ≈ 460× FDV-to-total-liquidity) even though
hundreds of thousands to millions of dollars of liquidity can absorb ordinary trades. Below $500k of total liquidity the
ratio is what matters, so the original 50× threshold applies there.

Why the Solana honeypot rule: Solana has no buy/sell simulation like GoPlus runs on EVM chains, and GeckoTerminal
usually reports "unknown". On Solana the ways an issuer can stop you selling are on-chain and are checked directly
(freeze authority, transfer hook, non-transferable, balance-changing authority, default-frozen accounts), so when all of
those are known to be clear the missing heuristic adds no information. A heuristic "possible honeypot" flag is still a CAUTION.

Notes are informational lines returned next to the reasons (for example "Liquidity trend not tracked yet (first check)").
They never change the verdict.

Critical sources: Solana RPC, GeckoTerminal and DexScreener on Solana; GoPlus and DexScreener on EVM chains.
GoPlus (Solana) and RugCheck are non-critical extras. Hard fails are listed before cautions; at most six reasons are shown,
and the full flag list is in the report's Security flags section.
