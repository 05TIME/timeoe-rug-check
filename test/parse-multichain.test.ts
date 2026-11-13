import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import * as p from "../src/server/parse";

const fx = (n: string) => JSON.parse(readFileSync(new URL(`./fixtures/${n}`, import.meta.url), "utf8"));
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const AERO = "0x940181a94A35A4569E4529A3CDfB74e38FD98631";
const CAKE = "0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82";
const BONK = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
const NOW = Date.parse("2026-11-13T20:00:00Z");

describe("parseDexMarket", () => {
  it("USDC on Ethereum: price, liquidity, volume, caps, socials", () => {
    const m = p.parseDexMarket(fx("dex-usdc-eth.json"), USDC, NOW);
    expect(m.pairs).toBe(4);
    expect(m.priceUsd).toBeGreaterThan(0.9);
    expect(m.liquidityUsd).toBeGreaterThan(1_000_000);
    expect(m.volume24hUsd).toBeGreaterThan(0);
    expect(m.marketCapUsd).toBeGreaterThan(1e9);
    expect(m.pairUrl).toMatch(/^https:\/\/dexscreener\.com\/ethereum\//);
    expect(m.websites[0].url).toMatch(/circle\.com/);
    expect(m.poolAgeHours).toBeGreaterThan(0);
  });
  it("AERO on Base and CAKE on BNB Chain", () => {
    const a = p.parseDexMarket(fx("dex-aero-base.json"), AERO, NOW);
    expect(a.dex).toBe("aerodrome"); expect(a.quoteSymbol).toBe("USDC");
    const c = p.parseDexMarket(fx("dex-cake-bsc.json"), CAKE, NOW);
    expect(c.dex).toBe("pancakeswap"); expect(c.priceUsd).toBeGreaterThan(0);
  });
  it("accepts the search shape and an empty result", () => {
    expect(p.parseDexMarket(fx("dex-search-cake.json"), CAKE, NOW).pairs).toBe(3);
    expect(p.parseDexMarket({ schemaVersion: "1.0.0", pairs: null }, CAKE, NOW)).toEqual({ pairs: 0, websites: [], socials: [] });
    expect(p.parseDexMarket([], CAKE, NOW).pairs).toBe(0);
  });
  it("no price or caps when the token is only ever the quote token", () => {
    const pairs = fx("dex-usdc-eth.json").map((x: any) => ({ ...x, baseToken: x.quoteToken, quoteToken: x.baseToken }));
    const m = p.parseDexMarket(pairs, USDC, NOW);
    expect(m.priceUsd).toBeUndefined(); expect(m.marketCapUsd).toBeUndefined();
    expect(m.liquidityUsd).toBeGreaterThan(0);
  });
  it("drops non-http links", () => {
    const pairs = fx("dex-aero-base.json");
    pairs[0].info.websites = [{ label: "x", url: "javascript:alert(1)" }, { label: "ok", url: "https://aerodrome.finance" }];
    expect(p.parseDexMarket(pairs, AERO, NOW).websites.map((w) => w.url)).toEqual(["https://aerodrome.finance/"]);
  });
  it("throws on a bad body", () => expect(() => p.parseDexMarket({ nope: 1 }, USDC, NOW)).toThrow());
});

describe("parseDexSearchChains", () => {
  it("sums liquidity per chain for pools containing the token", () => {
    const usdc = p.parseDexSearchChains(fx("dex-search-usdc.json"), USDC);
    // Same address also exists on PulseChain (an Ethereum fork); the caller ignores unsupported chains.
    expect(Object.keys(usdc).sort()).toEqual(["ethereum", "pulsechain"]);
    expect(usdc.ethereum).toBeGreaterThan(0);
    expect(p.parseDexSearchChains(fx("dex-search-cake.json"), CAKE)).toHaveProperty("bsc");
  });
  it("null pairs means no pools; junk throws", () => {
    expect(p.parseDexSearchChains({ pairs: null }, USDC)).toEqual({});
    expect(() => p.parseDexSearchChains({}, USDC)).toThrow();
  });
});

describe("parseGoPlusEvm", () => {
  it("USDC: proxy, verified, not a honeypot, holders and CEX listings", () => {
    const g = p.parseGoPlusEvm(fx("goplus-usdc-eth.json"), USDC);
    expect(g).toMatchObject({ chainFamily: "evm", symbol: "USDC", honeypotSimulated: false, proxy: true, sourceVerified: true, buyTax: 0, sellTax: 0, trusted: true });
    expect(g.holderCount).toBeGreaterThan(1_000_000);
    expect(g.top10HolderShare).toBeGreaterThan(0.1);
    expect(g.top10HolderShare).toBeLessThan(0.5);
    expect(g.listedOnCex).toContain("Coinbase");
  });
  it("AERO: mintable, LP holders parsed to a locked share", () => {
    const g = p.parseGoPlusEvm(fx("goplus-aero-base.json"), AERO);
    expect(g.mintable).toBe(true);
    expect(g.lpLockedShare).toBeGreaterThanOrEqual(0);
    expect(g.lpLockedShare).toBeLessThanOrEqual(1);
  });
  it("CAKE: owner address and missing taxes stay unknown", () => {
    const g = p.parseGoPlusEvm(fx("goplus-cake-bsc.json"), CAKE);
    expect(g.ownerAddress).toMatch(/^0x73feaa/);
    expect(g.buyTax).toBeUndefined();
  });
  it("synthetic honeypot", () => {
    const g = p.parseGoPlusEvm(fx("goplus-honeypot-synthetic.json"), "0x2222222222222222222222222222222222222222");
    expect(g).toMatchObject({ honeypotSimulated: true, sellTax: 0.99, sourceVerified: false, ownerCanChangeBalance: true, hiddenOwner: true, blacklist: true });
  });
  it("burned LP counts as locked", () => {
    const body = { code: 1, result: { [USDC.toLowerCase()]: { lp_holders: [
      { address: "0x000000000000000000000000000000000000dead", percent: "0.7", is_locked: 0 },
      { address: "0xabc", percent: "0.2", is_locked: 1 }, { address: "0xdef", percent: "0.1", is_locked: 0 }] } } };
    expect(p.parseGoPlusEvm(body, USDC).lpLockedShare).toBeCloseTo(0.9);
  });
  it("throws on error codes or unindexed tokens", () => {
    expect(() => p.parseGoPlusEvm({ code: 4029, message: "too many requests" }, USDC)).toThrow(/too many/);
    expect(() => p.parseGoPlusEvm({ code: 1, result: {} }, USDC)).toThrow(/not indexed/);
    expect(() => p.parseGoPlusEvm({ code: 1, result: { [USDC]: {} } }, USDC)).toThrow(/not indexed/);
  });
});

describe("parseGoPlusSolana", () => {
  it("Bonk: authorities revoked, holders, Token-2022 extras", () => {
    const g = p.parseGoPlusSolana(fx("goplus-bonk-sol.json"), BONK);
    expect(g).toMatchObject({ symbol: "Bonk", mintAuthorityActive: false, freezeAuthorityActive: false, balanceMutable: false, nonTransferable: false, transferHook: false, transferFee: false, metadataMutable: true });
    expect(g.holderCount).toBe(1021397);
    expect(g.top10HolderShare).toBeGreaterThan(0.2);
  });
});

describe("ERC-20 decoding", () => {
  const rpc = fx("rpc-erc20-usdc.json");
  it("decodes name, symbol, decimals, totalSupply", () => {
    expect(p.decodeAbiString(rpc["0x06fdde03"].result)).toBe("USD Coin");
    expect(p.decodeAbiString(rpc["0x95d89b41"].result)).toBe("USDC");
    expect(p.decodeUint(rpc["0x313ce567"].result)).toBe(6n);
    expect(p.formatUnits(p.decodeUint(rpc["0x18160ddd"].result)!, 6)).toMatch(/^44,\d{3},\d{3},\d{3}\.\d+$/);
  });
  it("decodes a bytes32 symbol (MKR style)", () => {
    expect(p.decodeAbiString("0x4d4b520000000000000000000000000000000000000000000000000000000000")).toBe("MKR");
  });
  it("empty and junk answers are undefined", () => {
    expect(p.decodeUint("0x")).toBeUndefined();
    expect(p.decodeAbiString("0x")).toBeUndefined();
    expect(p.decodeUint("nope")).toBeUndefined();
  });
  it("formatUnits", () => {
    expect(p.formatUnits(1234567891234n, 6)).toBe("1,234,567.8912");
    expect(p.formatUnits(1000n, 0)).toBe("1,000");
    expect(p.formatUnits(5000000n, 6)).toBe("5");
  });
});
