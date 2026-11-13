import { describe, it, expect } from "vitest";
import { CHAINS, EVM_CHAINS, chainByDexId, detectAddress, isChainKey, isEvmAddress } from "../src/chains";

describe("detectAddress", () => {
  it.each(["DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263", "So11111111111111111111111111111111111111112"])("Solana mint %s", (a) =>
    expect(detectAddress(a)).toEqual({ kind: "solana", address: a }));
  it.each(["0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", "0x940181a94a35a4569e4529a3cdfb74e38fd98631", "  0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82 "])("EVM address %s", (a) =>
    expect(detectAddress(a)).toEqual({ kind: "evm", address: a.trim() }));
  it.each(["", "0x123", "0xZZb86991c6218b36c1d19D4a2e9Eb0cE3606eB48", "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB4800", "hello world", "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB26O", 42, null, undefined])("invalid %s", (a) =>
    expect(detectAddress(a).kind).toBe("invalid"));
  it("isEvmAddress is strict", () => {
    expect(isEvmAddress("0x" + "a".repeat(40))).toBe(true);
    expect(isEvmAddress("a".repeat(40))).toBe(false);
  });
});

describe("chain registry", () => {
  it("covers the major EVM chains with GoPlus ids, keyless RPCs and explorers", () => {
    expect(EVM_CHAINS).toEqual(["ethereum", "bsc", "base", "arbitrum", "polygon", "optimism", "avalanche"]);
    for (const k of EVM_CHAINS) {
      expect(CHAINS[k].family).toBe("evm");
      expect(CHAINS[k].rpcs.length).toBeGreaterThan(0);
      expect(CHAINS[k].rpcs.every((u) => u.startsWith("https://"))).toBe(true);
      expect(CHAINS[k].explorerToken("0xabc")).toMatch(/^https:\/\/.+0xabc$/);
    }
    expect(CHAINS.bsc.goplusId).toBe("56");
    expect(CHAINS.base.goplusId).toBe("8453");
  });
  it("maps DexScreener chain ids", () => {
    expect(chainByDexId("bsc")).toBe("bsc");
    expect(chainByDexId("ethereum")).toBe("ethereum");
    expect(chainByDexId("pulsechain")).toBeUndefined();
  });
  it("isChainKey", () => {
    expect(isChainKey("base")).toBe(true);
    expect(isChainKey("toString")).toBe(false);
    expect(isChainKey("pulsechain")).toBe(false);
  });
});
