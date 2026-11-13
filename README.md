# TIMEŒ Rug Check

A free, read-only multichain token rug-check. Paste a Solana mint or a 0x token contract (Ethereum, BNB Chain, Base, Arbitrum, Polygon, Optimism, Avalanche) and get a plain PASS / CAUTION / FAIL verdict with reasons, plus a report: price, market cap, liquidity, volume, pool age, holders, top-10 share, taxes, honeypot simulation, owner powers and source links.

**Not financial advice.** It never asks for a wallet, seed phrase or keys.

## How it works
- `src/verdict`: pure, dependency-free verdict package. Signals in, PASS / CAUTION / FAIL plus plain reasons out. Unknown data is never treated as safe.
- `src/chains`: chain registry and address detection. `0x` + 40 hex is EVM; base58 that decodes to 32 bytes is Solana.
- `src/server`: server-only fetchers, a 60s per-token cache, an in-memory liquidity snapshot, and a per-IP rate limit. Thresholds come from env vars (`RC_*`) with defaults in `src/server/config.ts`. Every external call has a 7s timeout (`RC_FETCH_TIMEOUT_MS`); a failed source is shown as unavailable and never crashes the check.
  - Solana: public RPC (mint/freeze authority, Token/Token-2022 owner check), GeckoTerminal, DexScreener, GoPlus Solana token security, RugCheck.xyz summary.
  - EVM: chain auto-detection (DexScreener pools across chains, confirmed with `eth_getCode`; if no pools, `eth_getCode` on every supported chain), ERC-20 `name/symbol/decimals/totalSupply` via `eth_call` on keyless public RPCs (publicnode with official fallbacks), GoPlus token security, DexScreener market data. An address with no contract code, or whose `totalSupply()` reverts, returns HTTP 400 "That address is not a token contract."
- `app/`: Next.js page and `GET /api/check?address=…&chain=…` (`chain` optional, `mint=` still accepted). Responses contain the verdict, reasons, sources (with links), the report sections, and short fact lines for the explanation.
- Verdict rules: see [`docs/verdict-rules.md`](docs/verdict-rules.md).

No API keys are needed. Optional env vars: `EVM_RPC_URL_<CHAIN>` (e.g. `EVM_RPC_URL_ETHEREUM`) to use your own RPC, `GOPLUS_ACCESS_TOKEN` for higher GoPlus rate limits, `SOLANA_RPC_URL`.
- `src/ai`: optional plain-English explanation. It runs in the browser after the verdict and cannot replace it.

Read-only: no wallet connection, no signing, no keys, no analytics.

## Hybrid explanation
After a check, the page can explain the verdict and answer a few follow-up questions.

The PASS / CAUTION / FAIL result still comes only from `src/verdict`. Firebase AI Logic is asked for JSON, that JSON is checked with Zod, and anything that echoes a different verdict, fails the schema, or gives a trade or key-handling instruction is thrown away. The badge on screen is never written by the model.

Firebase AI Logic is created with `InferenceMode.PREFER_ON_DEVICE`. Desktop Chrome uses Gemini Nano through the built-in Prompt API when that model is available. Otherwise the same prompt goes to cloud `gemini-3.5-flash-lite`. The card says which path ran. The on-device prompt is kept small, and Chrome's context measurement runs before the call. If Nano still rejects the input as too large (`QuotaExceededError`), the same question is sent to the cloud model and the card says the cloud path answered. `initializeDeviceModel()` runs on the Explain click, which is the user gesture Chrome requires before an on-device download. The JSON schema is applied as a response constraint with `omitResponseConstraintInput`, so the schema itself is not copied into Nano's context window.

Follow-ups are new single-turn `generateContent` calls that include the verdict and the accepted explanation. On-device hybrid inference does not support multi-turn chat, and a chat session would fall through to the cloud.

App Check is initialized with reCAPTCHA Enterprise (`ReCaptchaEnterpriseProvider`) when a site key or a local debug token is set. The site key is read from `NEXT_PUBLIC_FIREBASE_APPCHECK_RECAPTCHA_ENTERPRISE_SITE_KEY`. If that is blank, `NEXT_PUBLIC_FIREBASE_APPCHECK_RECAPTCHA_SITE_KEY` is used as a name fallback and is still given to the Enterprise provider, so a classic reCAPTCHA v3 key will not work. With neither key nor a debug token, App Check stays off: the page warns, and AI Logic still starts so Gemini Nano can run. Remote Config parameters `explain_enabled` and `max_followups` can turn the layer off or cap questions (default: on, 4). If Remote Config cannot be fetched, those defaults are used. If the `NEXT_PUBLIC_FIREBASE_*` web-app variables are missing, the check still runs and the page says explanations are off.

### Configure
Copy `.env.example` to `.env.local` and fill in the Firebase web config. Restart `npm run dev`, or rebuild, after changing them: Next.js inlines `NEXT_PUBLIC_` values at build time. Do not commit `.env.local`. Do not set `NEXT_PUBLIC_FIREBASE_APPCHECK_DEBUG_TOKEN` on a production deployment.

The Firebase JavaScript SDK 13 declares Node `>=24.12`. This app loads that SDK in the browser only. Tests, typecheck, and `next build` run on Node 22.

The deterministic checker, fetchers, and page already existed (MIT, 05TIME). The hybrid explanation layer was added for the #BuildHybridAI 2026 submission.

## Develop
```
npm ci && npm test && npm run typecheck && npm run build
```
CI config lives in `docs/ci/ci.yml`; copy it into `.github/workflows/` to enable.
