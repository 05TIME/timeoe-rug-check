"use client";

import { appCheckMode, readFirebasePublicConfig } from "./config";
import {
  DEFAULT_EXPLAIN_SETTINGS,
  isInputTooLarge,
  mapInferenceSource,
  settingsFromRemote,
  withOnDeviceFallback,
  type ExplainSettings,
  type Explainer,
  type HybridRuntime,
  type ModelTurn,
} from "./explain";
import { CLOUD_FALLBACK_MODEL, EXPLAIN_SYSTEM, FOLLOW_SYSTEM } from "./prompt";

export type { HybridRuntime };

let startup: Promise<HybridRuntime> | null = null;

/**
 * Loads Firebase AI Logic, App Check, and Remote Config once.
 * Does not call initializeDeviceModel — that has to happen on a click.
 */
export function startHybridAi(): Promise<HybridRuntime> {
  if (!startup) {
    startup = boot().catch((err) => {
      startup = null;
      throw err;
    });
  }
  return startup;
}

async function boot(): Promise<HybridRuntime> {
  const config = readFirebasePublicConfig();
  if (!config) throw new Error("Firebase is not configured");
  if (typeof window === "undefined") throw new Error("Firebase AI Logic runs in the browser");

  const { getApps, initializeApp } = await import("firebase/app");
  const { initializeAppCheck, ReCaptchaV3Provider, CustomProvider } = await import("firebase/app-check");
  const { getAI, getGenerativeModel, GoogleAIBackend, InferenceMode, Schema } = await import("firebase/ai");
  const { getRemoteConfig, fetchAndActivate, getValue } = await import("firebase/remote-config");

  if (config.appCheckDebugToken) {
    const token = config.appCheckDebugToken === "true" ? true : config.appCheckDebugToken;
    (self as unknown as { FIREBASE_APPCHECK_DEBUG_TOKEN?: string | boolean }).FIREBASE_APPCHECK_DEBUG_TOKEN = token;
  }

  const app = getApps()[0] ?? initializeApp({
    apiKey: config.apiKey,
    authDomain: config.authDomain,
    projectId: config.projectId,
    appId: config.appId,
    ...(config.storageBucket ? { storageBucket: config.storageBucket } : {}),
    ...(config.messagingSenderId ? { messagingSenderId: config.messagingSenderId } : {}),
  });

  const provider = config.appCheckSiteKey
    ? new ReCaptchaV3Provider(config.appCheckSiteKey)
    : config.appCheckDebugToken
      // Debug exchange does not call the provider. initializeAppCheck still requires one.
      ? new CustomProvider({ getToken: async () => ({ token: "unused-debug-placeholder", expireTimeMillis: Date.now() + 60_000 }) })
      : null;
  if (provider) {
    try {
      initializeAppCheck(app, { provider, isTokenAutoRefreshEnabled: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : "";
      if (!/already exists|already initialized/i.test(message)) throw err;
    }
  }

  const ai = getAI(app, { backend: new GoogleAIBackend() });
  const verdictEcho = Schema.enumString({ enum: ["PASS", "CAUTION", "FAIL"] });
  const notAdvice = Schema.boolean();
  const explainSchema = Schema.object({
    properties: {
      verdictEcho,
      headline: Schema.string(),
      plainEnglish: Schema.string(),
      whyTheseReasons: Schema.array({ items: Schema.string(), maxItems: 4 }),
      whatYouCanDo: Schema.array({ items: Schema.string(), maxItems: 3 }),
      notAdvice,
    },
  });
  const followSchema = Schema.object({
    properties: {
      verdictEcho,
      answer: Schema.string(),
      notAdvice,
    },
  });
  const explainDevice = getGenerativeModel(ai, deviceParams(InferenceMode.PREFER_ON_DEVICE, EXPLAIN_SYSTEM, explainSchema));
  const explainCloud = getGenerativeModel(ai, cloudParams(InferenceMode.ONLY_IN_CLOUD, EXPLAIN_SYSTEM, explainSchema));
  const followDevice = getGenerativeModel(ai, deviceParams(InferenceMode.PREFER_ON_DEVICE, FOLLOW_SYSTEM, followSchema));
  const followCloud = getGenerativeModel(ai, cloudParams(InferenceMode.ONLY_IN_CLOUD, FOLLOW_SYSTEM, followSchema));

  let prepared = false;
  const explainer: Explainer = {
    async prepare(onDownload) {
      if (prepared) return;
      await Promise.all([
        explainDevice.initializeDeviceModel(onDownload),
        followDevice.initializeDeviceModel(),
      ]);
      prepared = true;
    },
    explain: (prompt) => turn(explainDevice, explainCloud, prompt, explainSchema, EXPLAIN_SYSTEM),
    followUp: (prompt) => turn(followDevice, followCloud, prompt, followSchema, FOLLOW_SYSTEM),
  };

  return {
    explainer,
    settings: await readRemoteSettings(app, getRemoteConfig, fetchAndActivate, getValue),
    appCheck: appCheckMode(config),
  };
}

function deviceParams(mode: "prefer_on_device", system: string, responseSchema: ReturnType<typeof import("firebase/ai").Schema.object>) {
  return {
    mode,
    inCloudParams: cloudBody(system, responseSchema),
    onDeviceParams: {
      createOptions: sessionOptions(system),
      // omitResponseConstraintInput keeps the JSON schema out of Nano's context window.
      // Constrained decoding still applies. The system prompt names the keys.
      promptOptions: { responseConstraint: responseSchema, omitResponseConstraintInput: true },
    },
  };
}

function cloudParams(mode: "only_in_cloud", system: string, responseSchema: ReturnType<typeof import("firebase/ai").Schema.object>) {
  return {
    mode,
    inCloudParams: cloudBody(system, responseSchema),
  };
}

function cloudBody(system: string, responseSchema: ReturnType<typeof import("firebase/ai").Schema.object>) {
  return {
    model: CLOUD_FALLBACK_MODEL,
    systemInstruction: system,
    generationConfig: { maxOutputTokens: 1024, responseMimeType: "application/json" as const, responseSchema },
  };
}

function sessionOptions(system: string) {
  return {
    expectedInputs: [{ type: "text" as const, languages: ["en"] }],
    expectedOutputs: [{ type: "text" as const, languages: ["en"] }],
    initialPrompts: [{ role: "system" as const, content: [{ type: "text" as const, value: system }] }],
  };
}

type Generative = {
  initializeDeviceModel: Explainer["prepare"];
  generateContent: (prompt: string) => Promise<{ response: { text: () => string; inferenceSource?: unknown } }>;
};

async function turn(deviceModel: Generative, cloudModel: Generative, prompt: string, responseSchema: ReturnType<typeof import("firebase/ai").Schema.object>, system: string): Promise<ModelTurn> {
  return withOnDeviceFallback({
    measure: () => measureNanoPrompt(prompt, responseSchema, system),
    runOnDevice: () => callModel(deviceModel, prompt),
    runInCloud: () => callModel(cloudModel, prompt),
  });
}

async function callModel(model: Generative, prompt: string): Promise<ModelTurn> {
  const result = await model.generateContent(prompt);
  return { text: result.response.text(), inferenceSource: mapInferenceSource(result.response.inferenceSource) };
}

interface NanoSession {
  measureContextUsage?: (input: unknown, options?: object) => Promise<number>;
  measureInputUsage?: (input: unknown, options?: object) => Promise<number>;
  contextUsage?: number;
  contextWindow?: number;
  inputQuota?: number;
  destroy?: () => void;
}

/** Best-effort preflight. A missing API or a failed measurement still lets the on-device call try. */
async function measureNanoPrompt(prompt: string, responseSchema: ReturnType<typeof import("firebase/ai").Schema.object>, system: string): Promise<{ usage: number; windowSize: number } | null> {
  const LanguageModel = (globalThis as { LanguageModel?: { create?: (options?: object) => Promise<NanoSession> } }).LanguageModel;
  if (!LanguageModel?.create) return null;
  let session: NanoSession | undefined;
  try {
    session = await LanguageModel.create(sessionOptions(system));
    const measure = session.measureContextUsage ?? session.measureInputUsage;
    if (!measure) return null;
    const usage = await measure.call(session, [{ role: "user", content: [{ type: "text", value: prompt }] }], {
      responseConstraint: responseSchema,
      omitResponseConstraintInput: true,
    });
    const windowSize = session.contextWindow ?? session.inputQuota;
    const alreadyUsed = typeof session.contextUsage === "number" ? session.contextUsage : 0;
    if (typeof usage !== "number" || typeof windowSize !== "number") return null;
    return { usage, windowSize: windowSize - alreadyUsed };
  } catch (err) {
    if (isInputTooLarge(err)) throw err;
    return null;
  } finally {
    session?.destroy?.();
  }
}

async function readRemoteSettings(
  app: import("firebase/app").FirebaseApp,
  getRemoteConfig: typeof import("firebase/remote-config").getRemoteConfig,
  fetchAndActivate: typeof import("firebase/remote-config").fetchAndActivate,
  getValue: typeof import("firebase/remote-config").getValue,
): Promise<ExplainSettings> {
  try {
    const remoteConfig = getRemoteConfig(app);
    remoteConfig.settings.minimumFetchIntervalMillis = 60_000;
    remoteConfig.settings.fetchTimeoutMillis = 4_000;
    remoteConfig.defaultConfig = { explain_enabled: "true", max_followups: "4" };
    await fetchAndActivate(remoteConfig);
    return settingsFromRemote({
      explain_enabled: getValue(remoteConfig, "explain_enabled").asString(),
      max_followups: getValue(remoteConfig, "max_followups").asString(),
    });
  } catch {
    return DEFAULT_EXPLAIN_SETTINGS;
  }
}
