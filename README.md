# TIMEŒ Rug Check

A free, read-only Solana token rug-check. Paste a mint address, get a plain PASS / CAUTION / FAIL verdict with reasons.

**Not financial advice.** It never asks for a wallet, seed phrase or keys.

## How it works
- `src/verdict`: pure, dependency-free verdict package. Signals in, PASS / CAUTION / FAIL plus plain reasons out. Unknown data is never treated as safe.
- `src/server`: server-only fetchers (Solana public RPC, GeckoTerminal, DexScreener, RugCheck free summary), a 60s per-mint cache, an in-memory liquidity snapshot, and a per-IP rate limit. Thresholds come from env vars (`RC_*`) with defaults in `src/server/config.ts`.
- `app/`: Next.js page and `GET /api/check?mint=…`. Responses contain only the verdict, reasons, sources and a timestamp.
- `src/ai`: optional plain-English explanation. It runs in the browser after the verdict and cannot replace it.

Read-only: no wallet connection, no signing, no keys, no analytics.

## Hybrid explanation
After a check, the page can explain the verdict and answer a few follow-up questions.

The PASS / CAUTION / FAIL result still comes only from `src/verdict`. Firebase AI Logic is asked for JSON, that JSON is checked with Zod, and anything that echoes a different verdict, fails the schema, or gives a trade or key-handling instruction is thrown away. The badge on screen is never written by the model.

Firebase AI Logic is created with `InferenceMode.PREFER_ON_DEVICE`. Desktop Chrome uses Gemini Nano through the built-in Prompt API when that model is available. Otherwise the same prompt goes to cloud `gemini-3.5-flash-lite`. The card says which path ran. `initializeDeviceModel()` runs on the Explain click, which is the user gesture Chrome requires before an on-device download.

Follow-ups are new single-turn `generateContent` calls that include the verdict and the accepted explanation. On-device hybrid inference does not support multi-turn chat, and a chat session would fall through to the cloud.

App Check is initialized when a reCAPTCHA v3 site key or a local debug token is set. Remote Config parameters `explain_enabled` and `max_followups` can turn the layer off or cap questions (default: on, 4). If Remote Config cannot be fetched, those defaults are used. If the `NEXT_PUBLIC_FIREBASE_*` variables are missing, the check still runs and the page says explanations are off.

### Configure
Copy `.env.example` to `.env.local` and fill in the Firebase web config. Restart `npm run dev`, or rebuild, after changing them: Next.js inlines `NEXT_PUBLIC_` values at build time. Do not commit `.env.local`. Do not set `NEXT_PUBLIC_FIREBASE_APPCHECK_DEBUG_TOKEN` on a production deployment.

The Firebase JavaScript SDK 13 declares Node `>=24.12`. This app loads that SDK in the browser only. Tests, typecheck, and `next build` run on Node 22.

The deterministic checker, fetchers, and page already existed (MIT, 05TIME). The hybrid explanation layer was added for the #BuildHybridAI 2026 submission.

## Develop
```
npm ci && npm test && npm run typecheck && npm run build
```
CI config lives in `docs/ci/ci.yml`; copy it into `.github/workflows/` to enable.
