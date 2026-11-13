import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { checkMint, _resetForTests, NotATokenMintError, type Fetcher } from "../src/server/check";
import { allow } from "../src/server/ratelimit";
import { GET } from "../app/api/check/route";

const fx = (n: string) => JSON.parse(readFileSync(new URL(`./fixtures/${n}`, import.meta.url), "utf8"));
const BONK = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
const NOW = Date.parse("2026-10-30T19:00:00Z");

function fake(over: Record<string, any> = {}): Fetcher & { calls: string[] } {
  const calls: string[] = [];
  const f: any = async (url: string, init?: RequestInit) => {
    const key = url.includes("geckoterminal") ? "gecko" : url.includes("dexscreener") ? "dex" : url.includes("rugcheck") ? "rug" : url.includes("gopluslabs") ? "goplus"
      : JSON.parse(String(init?.body)).method;
    calls.push(key);
    const v = key in over ? over[key] : ({ gecko: fx("gecko-bonk.json"), dex: fx("dex-bonk.json"), rug: fx("rug-bonk.json"), getAccountInfo: fx("rpc-mint-bonk.json"), goplus: fx("goplus-bonk-sol.json") } as Record<string, any>)[key];
    if (v instanceof Error || v === undefined) throw v ?? new Error("no fixture");
    return typeof v === "function" ? v() : v;
  };
  f.calls = calls; return f;
}

beforeEach(() => _resetForTests());

describe("checkMint (fixtures, no network)", () => {
  it("BONK first check: PASS; trend and Solana honeypot are notes, no thin-pool caution, all sources ok", async () => {
    const r = await checkMint(BONK, fake(), NOW);
    // GeckoTerminal reports honeypot status as unknown for Bonk, but every Solana sell-blocking check is clean.
    expect(r.verdict).toBe("PASS");
    expect(r.reasons).toEqual(["No red flags found in the data available. This does not mean the token is safe."]);
    expect(r.notes?.join(" ")).toMatch(/first check/);
    expect(r.notes?.join(" ")).toMatch(/No honeypot test exists for Solana/);
    expect(r.report?.market?.totalLiquidityUsd).toBeGreaterThan(r.report!.market!.liquidityUsd!);
    expect(r.symbol).toBe("Bonk");
    expect(r.sources.every((s) => s.ok)).toBe(true);
    expect(JSON.stringify(r)).not.toMatch(/score|threshold|minLiquidity/i);
    expect(r.chain).toEqual({ key: "solana", name: "Solana", family: "solana" });
    expect(r.report?.holders.holderCount).toBe(1021397);
    expect(r.report?.token.decimals).toBe(5);
    expect(r.report?.links.explorer.url).toBe(`https://solscan.io/token/${BONK}`);
    expect(r.report?.security.find((f) => f.label === "Mint authority revoked")?.state).toBe("ok");
    expect(r.facts?.[0]).toBe("Chain: Solana");
  });
  it("GoPlus down on Solana is not critical and adds no caution", async () => {
    const r = await checkMint(BONK, fake({ goplus: new Error("down") }), NOW);
    expect(r.sources.find((s) => s.name === "GoPlus")?.ok).toBe(false);
    expect(r.reasons.join(" ")).not.toMatch(/GoPlus/);
    expect(r.report?.holders.holderCount).toBeUndefined();
  });
  it("BONK with GoPlus down: sell checks unavailable, honeypot unknown stays a CAUTION", async () => {
    const r = await checkMint(BONK, fake({ goplus: new Error("down") }), NOW);
    expect(r.verdict).toBe("CAUTION");
    expect(r.reasons).toContain("Honeypot status is unknown.");
  });
  it("BONK with a transfer hook keeps honeypot unknown as a CAUTION", async () => {
    const gp = fx("goplus-bonk-sol.json");
    gp.result[BONK].transfer_hook = [{ address: "hook" }];
    const r = await checkMint(BONK, fake({ goplus: gp }), NOW);
    expect(r.verdict).toBe("CAUTION");
    expect(r.reasons).toEqual(expect.arrayContaining(["Honeypot status is unknown.", "The token runs custom code on every transfer (transfer hook)."]));
  });
  it("BONK with freeze authority set on-chain is a FAIL as before", async () => {
    const acct = fx("rpc-mint-bonk.json"); acct.result.value.data.parsed.info.freezeAuthority = "11111111111111111111111111111111";
    const r = await checkMint(BONK, fake({ getAccountInfo: acct }), NOW);
    expect(r.verdict).toBe("FAIL");
    expect(r.reasons[0]).toMatch(/Freeze authority is active/);
    expect(r.reasons).toContain("Honeypot status is unknown.");
  });
  it("GoPlus balance-mutable authority on Solana is a FAIL", async () => {
    const gp = fx("goplus-bonk-sol.json");
    gp.result[BONK].balance_mutable_authority = { authority: [{ address: "x" }], status: "1" };
    const r = await checkMint(BONK, fake({ goplus: gp }), NOW);
    expect(r.verdict).toBe("FAIL");
    expect(r.reasons[0]).toMatch(/change token balances/);
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
  it("uses getTokenLargestAccounts when GeckoTerminal and GoPlus are down", async () => {
    const supply = "8799430828123760242";
    const r = await checkMint(BONK, fake({ gecko: new Error("down"), goplus: new Error("down"),
      getTokenLargestAccounts: { result: { value: [{ amount: supply }] } } }), NOW);
    expect(r.verdict).toBe("CAUTION");
    expect(r.reasons.join(" ")).toMatch(/large share/);
  });
  it("GoPlus supplies holder concentration when GeckoTerminal is down", async () => {
    const r = await checkMint(BONK, fake({ gecko: new Error("down") }), NOW);
    expect(r.report?.holders.top10Share).toBeGreaterThan(0.2);
    expect(r.reasons.join(" ")).not.toMatch(/concentration is unknown/);
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
  it("a real account that is not a Token or Token-2022 mint is not a token mint", async () => {
    const system = { result: { value: { owner: "11111111111111111111111111111111", executable: true, lamports: 1, data: ["", "base64"] } } };
    await expect(checkMint("11111111111111111111111111111111", fake({ getAccountInfo: system }), NOW)).rejects.toBeInstanceOf(NotATokenMintError);
    const tokenAccount = fx("rpc-mint-bonk.json");
    tokenAccount.result.value.data.parsed.type = "account";
    await expect(checkMint(BONK, fake({ getAccountInfo: tokenAccount }), NOW + 61_000)).rejects.toMatchObject({ message: "That address is not a token mint." });
  });
  it("accepts a Token-2022 mint", async () => {
    const acct = fx("rpc-mint-bonk.json");
    acct.result.value.owner = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
    const r = await checkMint(BONK, fake({ getAccountInfo: acct }), NOW + 122_000);
    expect(r.verdict).toBe("PASS");
    expect(r.symbol).toBe("Bonk");
  });
  it("returns HTTP 400 for the System Program address", async () => {
    const previous = globalThis.fetch;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = init?.body ? String(init.body) : "";
      if (body.includes("getAccountInfo")) {
        return Response.json({ result: { value: { owner: "11111111111111111111111111111111", executable: true, lamports: 1, data: ["", "base64"] } } });
      }
      return new Response("no", { status: 404 });
    }) as typeof fetch;
    try {
      const res = await GET(new Request("http://localhost/api/check?mint=11111111111111111111111111111111", { headers: { "x-forwarded-for": "system-program" } }));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "That address is not a token mint." });
    } finally {
      globalThis.fetch = previous;
    }
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
