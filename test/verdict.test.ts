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
  it.each(["mintAuthorityActive", "freezeAuthorityActive", "honeypot", "top10HolderShare", "liquidityUsd", "poolAgeHours", "liquidityDropPct"] as const)(
    "unknown %s gives CAUTION at best", (k) => {
      const s = { ...clean }; delete (s as any)[k];
      expect(evaluate(s, T).verdict).toBe("CAUTION");
    });
  it("unknown liquidity trend says 'trend unknown'", () => {
    const { liquidityDropPct, ...s } = clean;
    expect(evaluate(s, T).reasons.join(" ")).toMatch(/trend unknown/);
  });
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
