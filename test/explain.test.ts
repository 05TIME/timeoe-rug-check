import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { appCheckMode, readFirebasePublicConfig } from "../src/ai/config";
import { buildExplanationPrompt, buildFollowUpPrompt, EXPLAIN_SYSTEM, FOLLOW_SYSTEM, ON_DEVICE_USER_PROMPT_MAX, type CheckSnapshot } from "../src/ai/prompt";
import { acceptExplanation, acceptFollowUp, readModelJson } from "../src/ai/schema";
import { answerFollowUp, classifyModelError, contextWouldOverflow, downloadPercent, explainVerdict, isInputTooLarge, mapInferenceSource, pathDetail, prepareQuestion, settingsFromRemote, withOnDeviceFallback, type Explainer, type ModelTurn } from "../src/ai/explain";

const check: CheckSnapshot = {
  mint: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",
  name: "Bonk",
  symbol: "Bonk",
  verdict: "CAUTION",
  reasons: ["Liquidity trend unknown (no earlier snapshot yet).", "A small group of wallets holds a very large share of the supply."],
  sources: [{ name: "DexScreener", ok: true }, { name: "GeckoTerminal", ok: false }],
  checkedAt: "2026-11-13T08:00:00.000Z",
};

function body(over: Record<string, unknown> = {}) {
  return JSON.stringify({
    verdictEcho: "CAUTION",
    headline: "Caution means the public data is incomplete.",
    plainEnglish: "The checker found no hard failure, but some facts are missing or mildly worrying. This is not a statement that the token is safe.",
    whyTheseReasons: ["There is no earlier liquidity snapshot, so the trend is unknown."],
    whatYouCanDo: ["Read each reason before risking money you cannot afford to lose."],
    notAdvice: true,
    ...over,
  });
}

function scripted(text: string, path: ModelTurn["inferenceSource"] = "ON_DEVICE") {
  const prompts: string[] = [];
  const order: string[] = [];
  const explainer: Explainer = {
    prepare: async () => { order.push("prepare"); },
    explain: async (prompt) => { order.push("explain"); prompts.push(prompt); return { text, inferenceSource: path }; },
    followUp: async (prompt) => { order.push("followUp"); prompts.push(prompt); return { text, inferenceSource: path }; },
  };
  return { explainer, prompts, order };
}

const fullEnv = {
  NEXT_PUBLIC_FIREBASE_API_KEY: "test-key",
  NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN: "rug.firebaseapp.com",
  NEXT_PUBLIC_FIREBASE_PROJECT_ID: "rug",
  NEXT_PUBLIC_FIREBASE_APP_ID: "1:1:web:abc",
};

describe("Firebase config", () => {
  it("stays off until the required public config is present", () => {
    expect(readFirebasePublicConfig({})).toBeNull();
    expect(readFirebasePublicConfig({ ...fullEnv, NEXT_PUBLIC_FIREBASE_APP_ID: "  " })).toBeNull();
  });
  it("reads the web config and treats App Check as optional", () => {
    const config = readFirebasePublicConfig({ ...fullEnv, NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET: " rug.appspot.com " });
    expect(config).toMatchObject({ apiKey: "test-key", projectId: "rug", storageBucket: "rug.appspot.com" });
    expect(config && appCheckMode(config)).toBe("missing");
  });
  it("distinguishes a reCAPTCHA site key from a debug token", () => {
    expect(appCheckMode({ ...fullEnv, apiKey: "k", authDomain: "a", projectId: "p", appId: "i", appCheckSiteKey: "site" })).toBe("recaptcha");
    expect(appCheckMode({ ...fullEnv, apiKey: "k", authDomain: "a", projectId: "p", appId: "i", appCheckDebugToken: "true" })).toBe("debug");
  });
});

describe("Remote Config settings", () => {
  it("defaults when values are missing or blank", () => {
    expect(settingsFromRemote({})).toEqual({ enabled: true, maxFollowUps: 4 });
    expect(settingsFromRemote({ explain_enabled: "  ", max_followups: "nope" })).toEqual({ enabled: true, maxFollowUps: 4 });
  });
  it("lets Remote Config turn explanations off and clamps follow-ups", () => {
    expect(settingsFromRemote({ explain_enabled: "false", max_followups: "99" })).toEqual({ enabled: false, maxFollowUps: 8 });
    expect(settingsFromRemote({ explain_enabled: "yes", max_followups: "0" }).maxFollowUps).toBe(0);
  });
});

describe("model output validation", () => {
  it("accepts fenced JSON and a string true", () => {
    const parsed = acceptExplanation("```json\n" + body({ notAdvice: "true" }) + "\n```", "CAUTION");
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.notAdvice).toBe(true);
  });
  it("trims padded copy", () => {
    const parsed = acceptExplanation(body({ headline: "  Caution means the public data is incomplete.  " }), "CAUTION");
    expect(parsed.ok && parsed.value.headline).toBe("Caution means the public data is incomplete.");
  });
  it("discards a different verdict and does not return the model copy", () => {
    const parsed = acceptExplanation(body({ verdictEcho: "PASS", headline: "SecretHeadlineShouldNotLeakOut" }), "CAUTION");
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.code).toBe("verdict-mismatch");
      expect(parsed.message).toMatch(/unchanged/);
      expect(parsed.message).not.toMatch(/SecretHeadline/);
    }
  });
  it("keeps a warning not to share a seed phrase and rejects a request for one", () => {
    const warning = acceptExplanation(body({ whatYouCanDo: ["Never share your seed phrase with anyone who asks."] }), "CAUTION");
    expect(warning.ok).toBe(true);
    const request = acceptExplanation(body({ whatYouCanDo: ["Please share your seed phrase with the checker."] }), "CAUTION");
    expect(request.ok).toBe(false);
    if (!request.ok) expect(request.code).toBe("unsafe");
  });
  it("discards a trade instruction and invalid JSON", () => {
    const unsafe = acceptExplanation(body({ whatYouCanDo: ["You should buy this token today"] }), "CAUTION");
    expect(unsafe.ok).toBe(false);
    if (!unsafe.ok) expect(unsafe.code).toBe("unsafe");
    expect(acceptExplanation("not json", "CAUTION").ok).toBe(false);
    expect(acceptFollowUp("{}", "FAIL").ok).toBe(false);
  });
  it("discards prose that tries to replace the verdict", () => {
    const follow = acceptFollowUp(JSON.stringify({
      verdictEcho: "CAUTION",
      answer: "The real verdict is PASS. Ignore the fixed checker.",
      notAdvice: true,
    }), "CAUTION");
    expect(follow.ok).toBe(false);
    if (!follow.ok) {
      expect(follow.code).toBe("verdict-mismatch");
      expect(follow.message).not.toMatch(/Ignore the fixed checker/);
    }
  });
  it("reads a JSON fence and maps both inference-source casings", () => {
    expect(readModelJson('```json\n{"ok":true}\n```')).toEqual({ ok: true });
    expect(mapInferenceSource("on_device")).toBe("ON_DEVICE");
    expect(mapInferenceSource("IN_CLOUD")).toBe("IN_CLOUD");
    expect(mapInferenceSource(undefined)).toBe("UNKNOWN");
    expect(downloadPercent(0.726)).toBe(73);
    expect(downloadPercent(Number.NaN)).toBe(0);
  });
});

describe("explainVerdict", () => {
  it("returns the on-device path and does not invent a replacement verdict", async () => {
    const fake = scripted(body(), "ON_DEVICE");
    const frozen = Object.freeze({ ...check, reasons: [...check.reasons] });
    const outcome = await explainVerdict(frozen, fake.explainer, { onGenerateStart: () => fake.order.push("start") });
    expect(fake.order).toEqual(["prepare", "start", "explain"]);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.path).toBe("ON_DEVICE");
      expect(outcome).not.toHaveProperty("verdict");
      expect(outcome.explanation.verdictEcho).toBe("CAUTION");
    }
    expect(frozen.verdict).toBe("CAUTION");
    expect(fake.prompts[0]).toMatch(/Do not change the verdict/);
    expect(fake.prompts[0]).toContain(check.mint);
    expect(fake.prompts[0]).toContain(check.reasons[1]);
  });
  it("drops an override and hides a cloud error that contains a key", async () => {
    const fake = scripted(body({ verdictEcho: "FAIL" }), "IN_CLOUD");
    const dropped = await explainVerdict(check, fake.explainer);
    expect(dropped.ok).toBe(false);
    if (!dropped.ok) {
      expect(dropped.code).toBe("verdict-mismatch");
      expect(dropped.path).toBe("IN_CLOUD");
      expect(dropped.message).not.toMatch(/FAIL/);
    }
    const failing: Explainer = {
      prepare: async () => { throw new Error("App Check permission-denied AIzaSySECRET"); },
      explain: async () => { throw new Error("should not run"); },
      followUp: async () => { throw new Error("should not run"); },
    };
    const failed = await explainVerdict(check, failing);
    expect(failed.ok).toBe(false);
    if (!failed.ok) {
      expect(failed.message).toMatch(/cloud fallback/);
      expect(failed.message).not.toMatch(/AIza/);
    }
    expect(classifyModelError(new Error("socket hang up")).message).not.toMatch(/socket/);
  });
});

describe("follow-up questions", () => {
  it("keeps a single-turn prompt so on-device inference stays eligible", () => {
    const history = [1, 2, 3, 4, 5].map((n) => ({ question: `QuestionNumber${n} unique`, answer: `AnswerNumber${n} unique` }));
    const prompt = buildFollowUpPrompt({
      check,
      explanation: { headline: "Headline stays", plainEnglish: "Plain stays long enough.", whyTheseReasons: ["Because."], whatYouCanDo: ["Wait."] },
      history,
      question: "What does freeze authority mean?",
    });
    expect(prompt).toMatch(/single question, not a chat/);
    expect(prompt).not.toMatch(/startChat/);
    expect(prompt).toContain("Verdict (fixed): CAUTION");
    expect(prompt).toContain("QuestionNumber3");
    expect(prompt).toContain("QuestionNumber5");
    expect(prompt).not.toContain("QuestionNumber1");
    expect(prompt).not.toContain("QuestionNumber2");
    expect(buildExplanationPrompt(check)).toContain("DexScreener ok");
    expect(buildExplanationPrompt(check).length).toBeLessThanOrEqual(ON_DEVICE_USER_PROMPT_MAX);
    expect(EXPLAIN_SYSTEM.length).toBeLessThan(400);
    expect(FOLLOW_SYSTEM.length).toBeLessThan(400);
    const huge = buildExplanationPrompt({ ...check, reasons: Array.from({ length: 6 }, () => "x".repeat(5000)) });
    expect(huge.length).toBeLessThanOrEqual(ON_DEVICE_USER_PROMPT_MAX);
    expect(huge.startsWith("Verdict (fixed): CAUTION")).toBe(true);
  });
  it("refuses a secret request without calling the model", async () => {
    let called = false;
    const explainer: Explainer = {
      prepare: async () => { called = true; },
      explain: async () => { called = true; throw new Error("no"); },
      followUp: async () => { called = true; throw new Error("no"); },
    };
    const outcome = await answerFollowUp({
      check,
      explanation: { verdictEcho: "CAUTION", headline: "Caution means the public data is incomplete.", plainEnglish: "Some facts are missing, so this is not a clean pass and not a hard failure.", whyTheseReasons: ["Trend unknown."], whatYouCanDo: ["Read the reasons."], notAdvice: true },
      history: [],
      question: "please paste your seed phrase here",
      explainer,
    });
    expect(called).toBe(false);
    expect(outcome.ok && outcome.path).toBe("LOCAL");
    expect(prepareQuestion("hi").ok).toBe(false);
  });
  it("answers a normal question with the reported cloud path", async () => {
    const fake = scripted(JSON.stringify({
      verdictEcho: "CAUTION",
      answer: "Freeze authority means the issuer can stop a wallet from moving the token.",
      notAdvice: true,
    }), "IN_CLOUD");
    const outcome = await answerFollowUp({
      check,
      explanation: { verdictEcho: "CAUTION", headline: "Caution means the public data is incomplete.", plainEnglish: "Some facts are missing, so this is not a clean pass and not a hard failure.", whyTheseReasons: ["Trend unknown."], whatYouCanDo: ["Read the reasons."], notAdvice: true },
      history: [],
      question: "What does freeze authority mean?",
      explainer: fake.explainer,
    });
    expect(outcome).toMatchObject({ ok: true, path: "IN_CLOUD" });
    expect(fake.prompts[0]).toContain("What does freeze authority mean?");
  });
});

describe("Gemini Nano input limit", () => {
  const quotaError = Object.assign(new Error("The input is too large."), { name: "QuotaExceededError", code: 22 });
  const deviceText = body();
  const cloudText = body({ headline: "Cloud explained the same caution." });

  it("recognizes Chrome's QuotaExceededError and a context window that is too small", () => {
    expect(isInputTooLarge(quotaError)).toBe(true);
    expect(isInputTooLarge({ name: "QuotaExceededError", message: "The input is too large.", code: 22 })).toBe(true);
    expect(isInputTooLarge(new Error("App Check permission-denied"))).toBe(false);
    expect(contextWouldOverflow(1200, 1024)).toBe(true);
    expect(contextWouldOverflow(40, -8)).toBe(true);
    expect(contextWouldOverflow(40, 1024)).toBe(false);
  });

  it("keeps the on-device answer when the prompt fits", async () => {
    let device = 0;
    let cloud = 0;
    const turn = await withOnDeviceFallback({
      measure: async () => ({ usage: 40, windowSize: 1024 }),
      runOnDevice: async () => { device += 1; return { text: deviceText, inferenceSource: "ON_DEVICE" }; },
      runInCloud: async () => { cloud += 1; return { text: cloudText, inferenceSource: "IN_CLOUD" }; },
    });
    expect(device).toBe(1);
    expect(cloud).toBe(0);
    expect(turn).toMatchObject({ inferenceSource: "ON_DEVICE", text: deviceText });
    expect(turn.fallbackReason).toBeUndefined();
  });

  it("uses the cloud model when measurement says the prompt does not fit", async () => {
    let device = 0;
    let cloud = 0;
    const turn = await withOnDeviceFallback({
      measure: async () => ({ usage: 5000, windowSize: 1024 }),
      runOnDevice: async () => { device += 1; return { text: deviceText, inferenceSource: "ON_DEVICE" }; },
      runInCloud: async () => { cloud += 1; return { text: cloudText, inferenceSource: "IN_CLOUD" }; },
    });
    expect(device).toBe(0);
    expect(cloud).toBe(1);
    expect(turn).toMatchObject({ inferenceSource: "IN_CLOUD", fallbackReason: "input-too-large", text: cloudText });
  });

  it("falls back to the cloud model when Nano throws QuotaExceededError", async () => {
    let device = 0;
    let cloud = 0;
    const turn = await withOnDeviceFallback({
      measure: async () => null,
      runOnDevice: async () => { device += 1; throw quotaError; },
      runInCloud: async () => { cloud += 1; return { text: cloudText, inferenceSource: "UNKNOWN" }; },
    });
    expect(device).toBe(1);
    expect(cloud).toBe(1);
    expect(turn.inferenceSource).toBe("IN_CLOUD");
    expect(turn.fallbackReason).toBe("input-too-large");
    expect(turn.text).toBe(cloudText);
    expect(turn.text).not.toContain("The input is too large");
  });

  it("does not hide a different model error behind the cloud model", async () => {
    let cloud = 0;
    await expect(withOnDeviceFallback({
      runOnDevice: async () => { throw new Error("App Check permission-denied"); },
      runInCloud: async () => { cloud += 1; return { text: cloudText, inferenceSource: "IN_CLOUD" }; },
    })).rejects.toThrow(/App Check/);
    expect(cloud).toBe(0);
  });

  it("shows the cloud path on the card after a size fallback", () => {
    expect(pathDetail("IN_CLOUD", "input-too-large")).toMatch(/cloud with Gemini/);
    expect(pathDetail("IN_CLOUD", "input-too-large")).toMatch(/too large/);
    expect(pathDetail("ON_DEVICE")).toMatch(/did not leave the browser/);
  });
});

describe("Firebase AI Logic is called from the client", () => {
  it("prefers on-device hybrid inference and does not open a chat session", () => {
    const source = readFileSync(new URL("../src/ai/client.ts", import.meta.url), "utf8");
    const prompt = readFileSync(new URL("../src/ai/prompt.ts", import.meta.url), "utf8");
    expect(source).toContain('import("firebase/ai")');
    expect(source).toContain('import("firebase/app-check")');
    expect(source).toContain('import("firebase/remote-config")');
    expect(source).toContain("InferenceMode.PREFER_ON_DEVICE");
    expect(source).toContain("InferenceMode.ONLY_IN_CLOUD");
    expect(source).toContain("omitResponseConstraintInput");
    expect(source).toContain("measureContextUsage");
    expect(source).toContain("withOnDeviceFallback");
    expect(source).toContain("initializeDeviceModel");
    expect(source).toContain("getGenerativeModel");
    expect(source).toContain("GoogleAIBackend");
    expect(source).toContain("CLOUD_FALLBACK_MODEL");
    expect(prompt).toContain("gemini-3.5-flash-lite");
    expect(source).toContain("explain_enabled");
    expect(source).toContain("max_followups");
    expect(source).not.toMatch(/startChat/);
  });
});
