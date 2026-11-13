import { describe, it, expect } from "vitest";
import { evaluate, type Signals, type Thresholds } from "../src/verdict";

const T: Thresholds = { minLiquidityUsd: 1000, minPoolAgeHours: 10, maxLiquidityDropPct: 0.3, maxTop10HolderShare: 0.5, warnFdvToLiquidity: 50 };
const clean: Signals = { mintAuthorityActive: false, freezeAuthorityActive: false, honeypot: false, top10HolderShare: 0.2, liquidityUsd: 5000, poolAgeHours: 100, liquidityDropPct: 0, fdvUsd: 10000 };

describe("evaluate", () => {
  it("PASS only when everything is known and clean, never worded as safe", () => {
    const r = evaluate(clean, T);
    expect(r.verdict).toBe("PASS");
    expect(r.reasons.join(" ")).toMatch(/does not mean the token is safe/);
  });
  it.each([
    ["mintAuthorityActive", true, /Mint authority/],
    ["freezeAuthorityActive", true, /Freeze authority/],
    ["liquidityUsd", 10, /liquidity is low/],
    ["poolAgeHours", 1, /very new/],
    ["liquidityDropPct", 0.8, /dropped sharply/],
  ] as const)("FAIL on %s", (k, v, re) => {
    const r = evaluate({ ...clean, [k]: v }, T);
    expect(r.verdict).toBe("FAIL");
    expect(r.reasons.some((x) => re.test(x))).toBe(true);
  });
  it.each(["mintAuthorityActive", "freezeAuthorityActive", "honeypot", "top10HolderShare", "liquidityUsd", "poolAgeHours"] as const)(
    "unknown %s gives CAUTION at best", (k) => {
      const s = { ...clean }; delete (s as any)[k];
      expect(evaluate(s, T).verdict).toBe("CAUTION");
    });
  it("unknown liquidity trend (first check) is a note only and does not cause CAUTION", () => {
    const { liquidityDropPct, ...s } = clean;
    const r = evaluate(s, T);
    expect(r.verdict).toBe("PASS");
    expect(r.reasons.join(" ")).not.toMatch(/trend/i);
    expect(r.notes.join(" ")).toMatch(/first check/);
  });
  it("a known trend adds no note", () => expect(evaluate(clean, T).notes).toEqual([]));
  it.each([
    ["honeypot", true, /possible honeypot/],
    ["top10HolderShare", 0.9, /large share/],
  ] as const)("%s red flag is a CAUTION, not a FAIL", (k, v, re) => {
    const r = evaluate({ ...clean, [k]: v }, T);
    expect(r.verdict).toBe("CAUTION");
    expect(r.reasons.some((x) => re.test(x))).toBe(true);
  });
  it("hard fails still list before the softened cautions", () => {
    const r = evaluate({ ...clean, honeypot: true, top10HolderShare: 0.9, mintAuthorityActive: true }, T);
    expect(r.verdict).toBe("FAIL");
    expect(r.reasons[0]).toMatch(/Mint authority/);
  });
  it("all-unknown is CAUTION", () => expect(evaluate({}, T).verdict).toBe("CAUTION"));
  it("thin pool and unavailable sources are cautions", () => {
    const r = evaluate({ ...clean, fdvUsd: 1e9, unavailableSources: ["DexScreener"] }, T);
    expect(r.verdict).toBe("CAUTION");
    expect(r.reasons.join(" ")).toMatch(/DexScreener was unavailable/);
  });
  it("second-opinion danger flags are cautions", () => {
    expect(evaluate({ ...clean, externalDangerFlags: ["Freeze Authority still enabled"] }, T).verdict).toBe("CAUTION");
  });
  it("fails list before cautions and caps reasons", () => {
    const r = evaluate({ mintAuthorityActive: true }, T);
    expect(r.verdict).toBe("FAIL");
    expect(r.reasons[0]).toMatch(/Mint authority/);
    expect(r.reasons.length).toBeLessThanOrEqual(6);
  });
  it("never exposes threshold numbers in reasons", () => {
    const r = evaluate({ ...clean, liquidityUsd: 10, poolAgeHours: 1, top10HolderShare: 0.9 }, T);
    expect(r.reasons.join(" ")).not.toMatch(/\d/);
  });
});

describe("evaluate: multichain rules", () => {
  const evm: Signals = {
    chainFamily: "evm", honeypotSimulated: false, buyTax: 0, sellTax: 0, sourceVerified: true,
    top10HolderShare: 0.2, liquidityUsd: 5000, poolAgeHours: 100, liquidityDropPct: 0, fdvUsd: 10000,
  };
  it("clean EVM token can PASS without Solana authority fields", () => {
    expect(evaluate(evm, T).verdict).toBe("PASS");
  });
  it.each([
    ["honeypotSimulated", true, /cannot be sold/],
    ["cannotBuy", true, /blocks buying/],
    ["sellTax", 0.6, /tax is extreme/],
    ["buyTax", 0.5, /tax is extreme/],
    ["sourceVerified", false, /not verified/],
    ["ownerCanChangeBalance", true, /change holders' balances/],
    ["selfDestruct", true, /self-destruct/],
    ["nonTransferable", true, /cannot be transferred/],
  ] as const)("EVM FAIL on %s", (k, v, re) => {
    const r = evaluate({ ...evm, [k]: v }, T);
    expect(r.verdict).toBe("FAIL");
    expect(r.reasons.some((x) => re.test(x))).toBe(true);
  });
  it.each([
    ["sellTax", 0.15, /tax is high/],
    ["mintable", true, /mint more/],
    ["proxy", true, /proxy/],
    ["blacklist", true, /blacklist/],
    ["pausable", true, /paused/],
    ["hiddenOwner", true, /hidden owner/],
    ["canTakeBackOwnership", true, /reclaimed/],
    ["taxModifiable", true, /change the trading tax/],
    ["tradingCooldown", true, /cooldown/],
    ["cannotSellAll", true, /whole balance/],
    ["creatorShare", 0.4, /creator wallet/],
    ["honeypot", true, /possible honeypot/],
  ] as const)("EVM CAUTION on %s", (k, v, re) => {
    const s: Signals = { ...evm, [k]: v };
    if (k === "honeypot") delete s.honeypotSimulated;
    const r = evaluate(s, T);
    expect(r.verdict).toBe("CAUTION");
    expect(r.reasons.some((x) => re.test(x))).toBe(true);
  });
  it("unknown honeypot (no GoPlus) is CAUTION on EVM", () => {
    const { honeypotSimulated, ...s } = evm;
    expect(evaluate(s, T).reasons.join(" ")).toMatch(/Honeypot status is unknown/);
  });
  it("unlocked LP is a caution only while the pool is young", () => {
    expect(evaluate({ ...evm, lpLockedShare: 0.1, poolAgeHours: 100 }, T).verdict).toBe("CAUTION");
    expect(evaluate({ ...evm, lpLockedShare: 0.1, poolAgeHours: 5000 }, T).verdict).toBe("PASS");
    expect(evaluate({ ...evm, lpLockedShare: 0.9, poolAgeHours: 100 }, T).verdict).toBe("PASS");
  });
  it("Solana Token-2022 extras", () => {
    const sol: Signals = { ...clean };
    expect(evaluate({ ...sol, balanceMutable: true }, T).verdict).toBe("FAIL");
    expect(evaluate({ ...sol, transferHook: true }, T).verdict).toBe("CAUTION");
    expect(evaluate({ ...sol, transferFee: true }, T).verdict).toBe("CAUTION");
  });
  it("EVM-only flags are ignored on Solana and vice versa", () => {
    expect(evaluate({ ...clean, proxy: true, mintable: true }, T).verdict).toBe("PASS");
    expect(evaluate({ ...evm, mintAuthorityActive: true, balanceMutable: true }, T).verdict).toBe("PASS");
  });
  it("thresholds are configurable and reasons still carry no numbers", () => {
    expect(evaluate({ ...evm, sellTax: 0.3 }, { ...T, failTax: 0.25 }).verdict).toBe("FAIL");
    const r = evaluate({ ...evm, sellTax: 0.9, honeypotSimulated: true, sourceVerified: false, creatorShare: 0.9 }, T);
    expect(r.reasons.join(" ")).not.toMatch(/\d/);
  });
});

describe("evaluate: thin-pool rule on total liquidity", () => {
  const base: Signals = { ...clean, liquidityUsd: 100_000, poolAgeHours: 1000 };
  const thin = /thin compared with the token's valuation/;
  it("shallow total liquidity with a high FDV ratio is a CAUTION", () => {
    const r = evaluate({ ...base, totalLiquidityUsd: 200_000, fdvUsd: 200_000 * 60 }, T);
    expect(r.verdict).toBe("CAUTION"); expect(r.reasons.some((x) => thin.test(x))).toBe(true);
  });
  it("uses the sum of all pools, not just the main pool", () => {
    expect(evaluate({ ...base, liquidityUsd: 100_000, totalLiquidityUsd: 400_000, fdvUsd: 10_000_000 }, T).verdict).toBe("PASS");
    expect(evaluate({ ...base, liquidityUsd: 100_000, fdvUsd: 10_000_000 }, T).verdict).toBe("CAUTION");
  });
  it("USDC-like: deep total liquidity, FDV/liquidity in the hundreds, no thin-pool caution", () => {
    const r = evaluate({ ...base, chainFamily: "evm", honeypotSimulated: false, sourceVerified: true, liquidityUsd: 135e6, totalLiquidityUsd: 222e6, fdvUsd: 46.7e9 }, T);
    expect(r.verdict).toBe("PASS");
  });
  it("Bonk-like: about $1M across pools, FDV ratio ~230, no thin-pool caution", () => {
    expect(evaluate({ ...base, liquidityUsd: 263_000, totalLiquidityUsd: 1_030_000, fdvUsd: 240e6 }, T).verdict).toBe("PASS");
  });
  it("deep liquidity still trips at an extreme ratio", () => {
    const r = evaluate({ ...base, totalLiquidityUsd: 600_000, fdvUsd: 600_000 * 1500 }, T);
    expect(r.reasons.some((x) => thin.test(x))).toBe(true);
  });
  it("thresholds are configurable", () => {
    expect(evaluate({ ...base, totalLiquidityUsd: 600_000, fdvUsd: 600_000 * 300 }, { ...T, extremeFdvToLiquidity: 200 }).verdict).toBe("CAUTION");
    expect(evaluate({ ...base, totalLiquidityUsd: 600_000, fdvUsd: 600_000 * 300 }, { ...T, deepLiquidityUsd: 1e6 }).verdict).toBe("CAUTION");
  });
});

describe("evaluate: Solana honeypot-unknown rule", () => {
  const sol: Signals = { ...clean, transferHook: false, nonTransferable: false, balanceMutable: false, defaultAccountFrozen: false };
  delete (sol as any).honeypot;
  it("all sell-blocking checks clean -> note only, PASS", () => {
    const r = evaluate(sol, T);
    expect(r.verdict).toBe("PASS");
    expect(r.notes.join(" ")).toMatch(/No honeypot test exists for Solana/);
  });
  it.each(["freezeAuthorityActive", "transferHook", "nonTransferable", "balanceMutable", "defaultAccountFrozen"] as const)(
    "%s unavailable keeps the honeypot caution", (k) => {
      const s = { ...sol }; delete (s as any)[k];
      const r = evaluate(s, T);
      expect(r.verdict).toBe("CAUTION");
      expect(r.reasons).toContain("Honeypot status is unknown.");
    });
  it.each([
    ["freezeAuthorityActive", "FAIL"], ["transferHook", "CAUTION"], ["nonTransferable", "FAIL"], ["balanceMutable", "FAIL"], ["defaultAccountFrozen", "CAUTION"],
  ] as const)("%s on keeps the honeypot caution (%s)", (k, v) => {
    const r = evaluate({ ...sol, [k]: true }, T);
    expect(r.verdict).toBe(v);
    expect(r.reasons).toContain("Honeypot status is unknown.");
  });
  it("a heuristic honeypot flag is still a caution", () => {
    expect(evaluate({ ...sol, honeypot: true }, T).verdict).toBe("CAUTION");
  });
  it("EVM is unchanged: unknown honeypot stays a caution even with the Solana fields clean", () => {
    const r = evaluate({ ...sol, chainFamily: "evm", sourceVerified: true }, T);
    expect(r.verdict).toBe("CAUTION");
    expect(r.reasons).toContain("Honeypot status is unknown.");
  });
});
