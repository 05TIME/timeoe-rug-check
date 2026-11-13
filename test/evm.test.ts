import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { checkEvm, checkToken, resolveEvmChain, _resetForTests, NotATokenContractError, type Fetcher } from "../src/server/check";
import { GET } from "../app/api/check/route";
import { CHAINS } from "../src/chains";

const fx = (n: string) => JSON.parse(readFileSync(new URL(`./fixtures/${n}`, import.meta.url), "utf8"));
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const CAKE = "0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82";
const SCAM = "0x2222222222222222222222222222222222222222";
const NOW = Date.parse("2026-11-13T20:00:00Z");
const rpcFx = fx("rpc-erc20-usdc.json");

type Over = {
  search?: unknown; pairs?: unknown; goplus?: unknown;
  /** chain key -> getCode reply (or Error). Default: code on ethereum only. */
  code?: Record<string, unknown>;
  calls?: Record<string, unknown>;
  failUrls?: string[];
};

function fake(o: Over = {}): Fetcher & { log: string[] } {
  const log: string[] = [];
  const f: any = async (url: string, init?: RequestInit) => {
    log.push(url);
    if (o.failUrls?.some((u) => url.startsWith(u))) throw new Error("network down");
    const pick = (v: unknown) => { if (v instanceof Error) throw v; return v; };
    if (url.includes("/latest/dex/tokens/")) return pick(o.search ?? fx("dex-search-usdc.json"));
    if (url.includes("/token-pairs/v1/")) return pick(o.pairs ?? fx("dex-usdc-eth.json"));
    if (url.includes("gopluslabs")) return pick(o.goplus ?? fx("goplus-usdc-eth.json"));
    const chain = (Object.keys(CHAINS) as (keyof typeof CHAINS)[]).find((k) => CHAINS[k].rpcs.includes(url));
    const body = JSON.parse(String(init?.body));
    if (body.method === "eth_getCode") {
      const v = o.code?.[chain!] ?? (chain === "ethereum" ? rpcFx.eth_getCode : rpcFx.noCode);
      return pick(v);
    }
    if (body.method === "eth_call") return pick(o.calls?.[body.params[0].data] ?? rpcFx[body.params[0].data]);
    throw new Error(`unexpected ${url}`);
  };
  f.log = log; return f;
}

beforeEach(() => _resetForTests());

describe("EVM chain detection", () => {
  it("uses DexScreener pools and ignores unsupported chains (PulseChain)", async () => {
    const r = await resolveEvmChain(USDC, undefined, fake(), NOW);
    expect(r).toEqual({ chain: "ethereum", codeConfirmed: true });
  });
  it("probes eth_getCode on every chain when no pools exist", async () => {
    const f = fake({ search: { pairs: null }, code: { ethereum: rpcFx.noCode, base: rpcFx.eth_getCode } });
    expect((await resolveEvmChain(USDC, undefined, f, NOW)).chain).toBe("base");
  });
  it("skips a DexScreener chain where the address has no code", async () => {
    const f = fake({ search: fx("dex-search-cake.json"), code: { bsc: rpcFx.noCode, ethereum: rpcFx.noCode, polygon: rpcFx.eth_getCode } });
    expect((await resolveEvmChain(CAKE, undefined, f, NOW)).chain).toBe("polygon");
  });
  it("no code anywhere -> not a token contract", async () => {
    await expect(resolveEvmChain(USDC, undefined, fake({ search: { pairs: null }, code: { ethereum: rpcFx.noCode } }), NOW)).rejects.toBeInstanceOf(NotATokenContractError);
  });
  it("every RPC down is an outage, not a 400", async () => {
    const f = fake({ search: { pairs: null }, failUrls: ["https://"] });
    await expect(resolveEvmChain(USDC, undefined, f, NOW)).rejects.not.toBeInstanceOf(NotATokenContractError);
  });
  it("a chain hint skips DexScreener search", async () => {
    const f = fake({ code: { bsc: rpcFx.eth_getCode } });
    expect(await resolveEvmChain(CAKE, "bsc", f, NOW)).toEqual({ chain: "bsc", codeConfirmed: true });
    expect(f.log.some((u) => u.includes("/latest/dex/tokens/"))).toBe(false);
  });
  it("falls back to the second public RPC when the first fails", async () => {
    const f = fake({ failUrls: [CHAINS.ethereum.rpcs[0]] });
    expect((await resolveEvmChain(USDC, "ethereum", f, NOW)).codeConfirmed).toBe(true);
    expect(f.log).toContain(CHAINS.ethereum.rpcs[1]);
  });
});

describe("checkEvm (fixtures, no network)", () => {
  it("USDC on Ethereum: CAUTION with rich report", async () => {
    const r = await checkToken({ address: USDC }, fake(), NOW);
    expect(r.chain).toEqual({ key: "ethereum", name: "Ethereum", family: "evm" });
    expect(r).toMatchObject({ name: "USD Coin", symbol: "USDC", verdict: "CAUTION" });
    // Upgradeable proxy is a real caution; first-check trend and thin-pool are not.
    expect(r.reasons).toEqual(["This is an upgradeable proxy, so the code can be changed later."]);
    expect(r.notes?.join(" ")).toMatch(/first check/);
    expect(r.reasons.join(" ")).not.toMatch(/mint authority|freeze authority/i);
    expect(r.report?.token).toMatchObject({ decimals: 6, trusted: true });
    expect(r.report?.token.totalSupply).toMatch(/^44,/);
    expect(r.report?.holders.holderCount).toBeGreaterThan(1e6);
    expect(r.report?.links.explorer.url).toBe(`https://etherscan.io/token/${USDC}`);
    expect(r.report?.links.dexscreener).toBe(`https://dexscreener.com/ethereum/${USDC}`);
    expect(r.sources.map((s) => s.name)).toEqual(["Ethereum RPC", "GoPlus", "DexScreener"]);
    expect(r.sources.every((s) => s.ok)).toBe(true);
    expect(r.facts).toContain("Chain: Ethereum");
    expect(JSON.stringify(r)).not.toMatch(/score|threshold|minLiquidity/i);
  });
  it("USDC-like token without the proxy flag is PASS on its first check", async () => {
    const gp = fx("goplus-usdc-eth.json");
    gp.result[USDC.toLowerCase()].is_proxy = "0";
    const r = await checkEvm(USDC, "ethereum", fake({ goplus: gp }), NOW);
    expect(r.verdict).toBe("PASS");
    expect(r.notes?.join(" ")).toMatch(/first check/);
  });
  it("synthetic honeypot is a FAIL listing the hard flags first", async () => {
    const f = fake({ goplus: fx("goplus-honeypot-synthetic.json"), search: { pairs: null }, pairs: [], code: { bsc: rpcFx.eth_getCode, ethereum: rpcFx.noCode } });
    const r = await checkEvm(SCAM, undefined, f, NOW);
    expect(r.chain.key).toBe("bsc");
    expect(r.verdict).toBe("FAIL");
    expect(r.reasons[0]).toMatch(/cannot be sold/);
    expect(r.reasons.join(" ")).toMatch(/tax is extreme/);
    expect(r.report?.security.find((x) => x.label.startsWith("Sell tax"))?.state).toBe("bad");
  });
  it("totalSupply revert -> not a token contract", async () => {
    await expect(checkEvm(USDC, "ethereum", fake({ calls: { "0x18160ddd": new (await import("../src/server/check")).RpcReplyError("execution reverted") } }), NOW))
      .rejects.toBeInstanceOf(NotATokenContractError);
  });
  it("empty totalSupply answer -> not a token contract", async () => {
    await expect(checkEvm(USDC, "ethereum", fake({ calls: { "0x18160ddd": { result: "0x" } } }), NOW)).rejects.toBeInstanceOf(NotATokenContractError);
  });
  it("GoPlus down -> CAUTION, partial report, honeypot unknown", async () => {
    const r = await checkEvm(USDC, undefined, fake({ goplus: new Error("timeout") }), NOW);
    expect(r.verdict).toBe("CAUTION");
    expect(r.reasons.join(" ")).toMatch(/Honeypot status is unknown/);
    expect(r.sources.find((s) => s.name === "GoPlus")?.ok).toBe(false);
    expect(r.report?.market?.priceUsd).toBeGreaterThan(0);
    expect(r.report?.holders.holderCount).toBeUndefined();
  });
  it("GoPlus rate limit body -> unavailable, not a crash", async () => {
    const r = await checkEvm(USDC, "ethereum", fake({ goplus: { code: 4029, message: "too many requests" } }), NOW);
    expect(r.sources.find((s) => s.name === "GoPlus")?.ok).toBe(false);
  });
  it("DexScreener down -> market null, names still from chain", async () => {
    const r = await checkEvm(USDC, "ethereum", fake({ pairs: new Error("503") }), NOW);
    expect(r.report?.market).toBeNull();
    expect(r.symbol).toBe("USDC");
    expect(r.reasons.join(" ")).toMatch(/DexScreener was unavailable|No trading pool/);
  });
  it("token metadata RPC failures leave on-chain fields unknown", async () => {
    const r = await checkEvm(USDC, "ethereum", fake({ failUrls: CHAINS.ethereum.rpcs }), NOW);
    expect(r.report?.token.decimals).toBeUndefined();
    expect(r.symbol).toBe("USDC"); // from GoPlus
    expect(r.sources.find((s) => s.name === "Ethereum RPC")?.ok).toBe(false);
  });
  it("caches per chain + address and detects a liquidity drop", async () => {
    const f = fake();
    await checkEvm(USDC, undefined, f, NOW); const n = f.log.length;
    await checkEvm(USDC, undefined, f, NOW + 30_000); expect(f.log.length).toBe(n);
    const drained = fx("dex-usdc-eth.json").map((x: any) => ({ ...x, liquidity: { ...x.liquidity, usd: x.liquidity.usd * 0.1 } }));
    const r = await checkEvm(USDC, undefined, fake({ pairs: drained }), NOW + 61_000);
    expect(r.verdict).toBe("FAIL");
    expect(r.reasons.join(" ")).toMatch(/dropped sharply/);
  });
});

describe("GET /api/check", () => {
  async function call(qs: string, impl: typeof fetch) {
    const previous = globalThis.fetch;
    globalThis.fetch = impl;
    try { return await GET(new Request(`http://localhost/api/check?${qs}`, { headers: { "x-forwarded-for": `t-${Math.random()}` } })); }
    finally { globalThis.fetch = previous; }
  }
  const noCode = (async (_u: RequestInfo | URL, init?: RequestInit) => {
    if (init?.body) return Response.json({ jsonrpc: "2.0", id: 1, result: "0x" });
    return Response.json({ schemaVersion: "1.0.0", pairs: null });
  }) as typeof fetch;

  it("400 for an EVM address with no contract on any chain", async () => {
    const res = await call("address=0x000000000000000000000000000000000000dEaD", noCode);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "That address is not a token contract." });
  });
  it("400 for garbage input, unknown chain, and chain/address mismatch", async () => {
    expect((await call("address=hello", noCode)).status).toBe(400);
    expect((await call(`address=${USDC}&chain=pulsechain`, noCode)).status).toBe(400);
    const mismatch = await call(`address=${USDC}&chain=solana`, noCode);
    expect(mismatch.status).toBe(400);
    expect((await mismatch.json()).error).toMatch(/not a Solana address/);
  });
  it("legacy mint= still routes Solana", async () => {
    const res = await call("mint=11111111111111111111111111111111", (async (_u: RequestInfo | URL, init?: RequestInit) =>
      String(init?.body ?? "").includes("getAccountInfo")
        ? Response.json({ result: { value: { owner: "11111111111111111111111111111111", executable: true, lamports: 1, data: ["", "base64"] } } })
        : new Response("no", { status: 404 })) as typeof fetch);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "That address is not a token mint." });
  });
});
