# TIMEŒ Rug Check

A free, read-only Solana token rug-check. Paste a mint address, get a plain PASS / CAUTION / FAIL verdict with reasons.

**Not financial advice.** It never asks for a wallet, seed phrase or keys.

## How it works
- `src/verdict`: pure, dependency-free verdict package. Signals in, PASS / CAUTION / FAIL plus plain reasons out. Unknown data is never treated as safe.
- `src/server`: server-only fetchers (Solana public RPC, GeckoTerminal, DexScreener, RugCheck free summary), a 60s per-mint cache, an in-memory liquidity snapshot, and a per-IP rate limit. Thresholds come from env vars (`RC_*`) with defaults in `src/server/config.ts`.
- `app/`: Next.js page and `GET /api/check?mint=…`. Responses contain only the verdict, reasons, sources and a timestamp.

Read-only: no wallet connection, no signing, no keys, no analytics.

## Develop
```
npm ci && npm test && npm run typecheck && npm run build
```
CI config lives in `docs/ci/ci.yml`; copy it into `.github/workflows/` to enable.
