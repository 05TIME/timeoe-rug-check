import { describe, it, expect } from "vitest";
import { aiFacts, securityFlags } from "../src/server/report";
import { buildExplanationPrompt, buildFollowUpPrompt, ON_DEVICE_USER_PROMPT_MAX, EXPLAIN_SYSTEM, type CheckSnapshot } from "../src/ai/prompt";
import { age, pct, usd } from "../src/format";

describe("securityFlags", () => {
  it("Solana: authorities and unknowns", () => {
    const f = securityFlags({ mintAuthorityActive: false, freezeAuthorityActive: true }, "solana");
    expect(f.find((x) => x.label === "Mint authority revoked")?.state).toBe("ok");
    expect(f.find((x) => x.label === "Freeze authority active")?.state).toBe("bad");
    expect(f.find((x) => x.label === "Honeypot: unknown")?.state).toBe("unknown");
  });
  it("EVM: taxes, owner, powers", () => {
    const f = securityFlags({ chainFamily: "evm", honeypotSimulated: false, buyTax: 0.05, sellTax: 0.2, sourceVerified: true, proxy: true }, "evm",
      { ownerAddress: "0x0000000000000000000000000000000000000000" });
    expect(f.map((x) => `${x.state}:${x.label}`)).toEqual([
      "ok:Honeypot simulation: can sell", "ok:Buy tax: 5%", "warn:Sell tax: 20%", "ok:Source code verified",
      "ok:No active owner (renounced or none)", "warn:Upgradeable proxy",
    ]);
  });
  it("EVM with no data is all unknown", () => {
    expect(securityFlags({ chainFamily: "evm" }, "evm").every((x) => x.state === "unknown")).toBe(true);
  });
});

describe("aiFacts + prompt budget", () => {
  const facts = aiFacts("Base", { pairs: 3, priceUsd: 0.48, priceChange24hPct: -7.7, liquidityUsd: 3.9e6, volume24hUsd: 8.6e5, marketCapUsd: 1.3e8, poolAgeHours: 27000, websites: [], socials: [] },
    { top10HolderShare: 0.9, buyTax: 0, sellTax: 0 }, 734541, [{ label: "Can mint more tokens", state: "warn" }]);
  it("summarizes market, holders, tax and flags", () => {
    expect(facts).toEqual([
      "Chain: Base", "Price $0.48 (-7.7% 24h)", "Liquidity $3.9M, 24h volume $860K", "Market cap $130M",
      "Main pool age 3.1 years", "Holders 734,541", "Top 10 hold 90%", "Tax buy 0% / sell 0%", "Flags: Can mint more tokens",
    ]);
  });
  it("no pools fact", () => expect(aiFacts("Ethereum", null, {}, undefined, [])).toEqual(["Chain: Ethereum", "No trading pools found"]));

  const check: CheckSnapshot = {
    mint: "0x940181a94A35A4569E4529A3CDfB74e38FD98631", address: "0x940181a94A35A4569E4529A3CDfB74e38FD98631", chain: { name: "Base" },
    name: "Aerodrome", symbol: "AERO", verdict: "CAUTION",
    reasons: ["The contract can mint more tokens.", "Liquidity trend unknown (no earlier snapshot yet)."],
    sources: [{ name: "GoPlus", ok: true }], checkedAt: "2026-11-13T20:00:00Z", facts,
  };
  it("explain prompt includes chain and facts and keeps the fixed verdict first", () => {
    const prompt = buildExplanationPrompt(check);
    expect(prompt.startsWith("Verdict (fixed): CAUTION")).toBe(true);
    expect(prompt).toContain("Chain: Base");
    expect(prompt).toContain("- Holders 734,541");
    expect(prompt).toContain("Sources: GoPlus ok");
    expect(prompt.length).toBeLessThanOrEqual(ON_DEVICE_USER_PROMPT_MAX);
    expect(EXPLAIN_SYSTEM).not.toMatch(/Solana/);
  });
  it("facts are dropped before reasons, sources or the question when space runs out", () => {
    const long = { ...check, reasons: Array.from({ length: 6 }, (_, i) => `Reason ${"x".repeat(95)} ${i}`), facts: Array.from({ length: 10 }, () => "f".repeat(90)) };
    const prompt = buildExplanationPrompt(long);
    expect(prompt.length).toBeLessThanOrEqual(ON_DEVICE_USER_PROMPT_MAX);
    expect(prompt).toContain("Sources: GoPlus ok");
    const follow = buildFollowUpPrompt({ check: long, explanation: { headline: "h".repeat(80), plainEnglish: "p".repeat(140), whyTheseReasons: [], whatYouCanDo: [] },
      history: [{ question: "q".repeat(80), answer: "a".repeat(100) }], question: "What does the mint flag mean?" });
    expect(follow.length).toBeLessThanOrEqual(ON_DEVICE_USER_PROMPT_MAX);
    expect(follow).toContain("Question: What does the mint flag mean?");
  });
});

describe("format", () => {
  it("usd/pct/age", () => {
    expect(usd(undefined)).toBe("unavailable");
    expect(usd(0.0000026)).toBe("$0.00000260");
    expect(usd(1234567)).toBe("$1.23M");
    expect(pct(0.256)).toBe("25.6%");
    expect(age(30)).toBe("30 h");
    expect(age(24 * 400)).toBe("13 months");
  });
});
