import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { checkMint, _resetForTests, type Fetcher } from "../src/server/check";
import { allow } from "../src/server/ratelimit";

const fx = (n: string) => JSON.parse(readFileSync(new URL(`./fixtures/${n}`, import.meta.url), "utf8"));
const BONK = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
const NOW = Date.parse("2026-10-30T19:00:00Z");

function fake(over: Record<string, any> = {}): Fetcher & { calls: string[] } {
  const calls: string[] = [];
  const f: any = async (url: string, init?: RequestInit) => {
    const key = url.includes("geckoterminal") ? "gecko" : url.includes("dexscreener") ? "dex" : url.includes("rugcheck") ? "rug"
      : JSON.parse(String(init?.body)).method;
    calls.push(key);
    const v = key in over ? over[key] : ({ gecko: fx("gecko-bonk.json"), dex: fx("dex-bonk.json"), rug: fx("rug-bonk.json"), getAccountInfo: fx("rpc-mint-bonk.json") } as Record<string, any>)[key];
    if (v instanceof Error || v === undefined) throw v ?? new Error("no fixture");
    return typeof v === "function" ? v() : v;
  };
  f.calls = calls; return f;
}

beforeEach(() => _resetForTests());

describe("checkMint (fixtures, no network)", () => {
  it("BONK first check is CAUTION with trend unknown and all sources ok", async () => {
    const r = await checkMint(BONK, fake(), NOW);
    expect(r.verdict).toBe("CAUTION");
    expect(r.symbol).toBe("Bonk");
    expect(r.reasons.join(" ")).toMatch(/trend unknown/);
    expect(r.sources.every((s) => s.ok)).toBe(true);
    expect(JSON.stringify(r)).not.toMatch(/score|threshold|minLiquidity/i);
  });
  it("caches for 60s per mint", async () => {
    const f = fake();
    await checkMint(BONK, f, NOW); const n = f.calls.length;
    await checkMint(BONK, f, NOW + 30_000); expect(f.calls.length).toBe(n);
    await checkMint(BONK, f, NOW + 61_000); expect(f.calls.length).toBeGreaterThan(n);
  });
  it("detects a liquidity drop from the in-memory snapshot", async () => {
    const dex = fx("dex-bonk.json");
    await checkMint(BONK, fake({ dex }), NOW);
    const drained = dex.map((p: any) => ({ ...p, liquidity: { ...p.liquidity, usd: p.liquidity.usd * 0.1 } }));
    const r = await checkMint(BONK, fake({ dex: drained }), NOW + 61_000);
    expect(r.verdict).toBe("FAIL");
    expect(r.reasons.join(" ")).toMatch(/dropped sharply/);
  });
  it("falls back to CAUTION when sources are down", async () => {
    const r = await checkMint(BONK, fake({ dex: new Error("down"), gecko: new Error("down"), rug: new Error("down"), getTokenLargestAccounts: new Error("429") }), NOW);
    expect(r.verdict).toBe("CAUTION");
    expect(r.reasons.join(" ")).toMatch(/unavailable/);
    expect(r.sources.find((s) => s.name === "DexScreener")?.ok).toBe(false);
  });
  it("uses getTokenLargestAccounts when GeckoTerminal is down", async () => {
    const supply = "8799430828123760242";
    const r = await checkMint(BONK, fake({ gecko: new Error("down"),
      getTokenLargestAccounts: { result: { value: [{ amount: supply }] } } }), NOW);
    expect(r.verdict).toBe("CAUTION");
    expect(r.reasons.join(" ")).toMatch(/large share/);
  });
  it("on-chain active mint authority is a FAIL even if GeckoTerminal says no", async () => {
    const acct = fx("rpc-mint-bonk.json"); acct.result.value.data.parsed.info.mintAuthority = "11111111111111111111111111111111";
    const r = await checkMint(BONK, fake({ getAccountInfo: acct }), NOW);
    expect(r.verdict).toBe("FAIL");
  });
  it("address with no account is FAIL 'no token'", async () => {
    const r = await checkMint(BONK, fake({ getAccountInfo: { result: { value: null } } }), NOW);
    expect(r.verdict).toBe("FAIL"); expect(r.reasons[0]).toMatch(/No token exists/);
  });
});

describe("rate limit", () => {
  it("allows max per window then blocks, then resets", () => {
    for (let i = 0; i < 3; i++) expect(allow("ip1", 3, 1000, 0)).toBe(true);
    expect(allow("ip1", 3, 1000, 10)).toBe(false);
    expect(allow("ip2", 3, 1000, 10)).toBe(true);
    expect(allow("ip1", 3, 1000, 1500)).toBe(true);
  });
});
