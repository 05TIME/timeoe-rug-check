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
| Honeypot status unknown | all | — | CAUTION |
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
| Liquidity dropped > 30% since last check (`RC_MAX_LIQUIDITY_DROP`) | all | in-memory snapshot | FAIL (no snapshot: CAUTION) |
| FDV / liquidity > 50 (`RC_WARN_FDV_TO_LIQ`) | all | DexScreener | CAUTION |
| RugCheck danger-level risk | Solana | RugCheck.xyz | CAUTION each |
| A critical source unavailable | all | — | CAUTION |

Critical sources: Solana RPC, GeckoTerminal and DexScreener on Solana; GoPlus and DexScreener on EVM chains.
GoPlus (Solana) and RugCheck are non-critical extras. Hard fails are listed before cautions; at most six reasons are shown,
and the full flag list is in the report's Security flags section.
