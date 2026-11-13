"use client";

import { appCheckMode, readFirebasePublicConfig } from "./config";
import {
  DEFAULT_EXPLAIN_SETTINGS,
  mapInferenceSource,
  settingsFromRemote,
  type ExplainSettings,
  type Explainer,
  type HybridRuntime,
  type ModelTurn,
} from "./explain";
import { CLOUD_FALLBACK_MODEL, SYSTEM_RULES } from "./prompt";

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
  const verdictEcho = Schema.enumString({ enum: ["PASS", "CAUTION", "FAIL"], description: "Copy the fixed verdict exactly." });
  const notAdvice = Schema.boolean({ description: "Must be true." });
  const shared = {
    mode: InferenceMode.PREFER_ON_DEVICE,
    inCloudParams: {
      model: CLOUD_FALLBACK_MODEL,
      systemInstruction: SYSTEM_RULES,
    },
    onDeviceParams: {
      createOptions: {
        expectedInputs: [{ type: "text" as const, languages: ["en"] }],
        expectedOutputs: [{ type: "text" as const, languages: ["en"] }],
        initialPrompts: [{ role: "system" as const, content: [{ type: "text" as const, value: SYSTEM_RULES }] }],
      },
    },
  };
  const explainSchema = Schema.object({
    properties: {
      verdictEcho,
      headline: Schema.string({ description: "One plain sentence." }),
      plainEnglish: Schema.string({ description: "What the verdict means. Not financial advice." }),
      whyTheseReasons: Schema.array({ items: Schema.string(), minItems: 1, maxItems: 6, description: "One plain sentence per checker reason." }),
      whatYouCanDo: Schema.array({ items: Schema.string(), minItems: 1, maxItems: 4, description: "Cautious next steps. Never say buy or sell." }),
      notAdvice,
    },
  });
  const followSchema = Schema.object({
    properties: {
      verdictEcho,
      answer: Schema.string({ description: "Answer the question. Do not change the verdict." }),
      notAdvice,
    },
  });

  const explainModel = getGenerativeModel(ai, hybridParams(shared, explainSchema));
  const followModel = getGenerativeModel(ai, hybridParams(shared, followSchema));

  let prepared = false;
  const explainer: Explainer = {
    async prepare(onDownload) {
      if (prepared) return;
      await Promise.all([
        explainModel.initializeDeviceModel(onDownload),
        followModel.initializeDeviceModel(),
      ]);
      prepared = true;
    },
    explain: (prompt) => turn(explainModel, prompt),
    followUp: (prompt) => turn(followModel, prompt),
  };

  return {
    explainer,
    settings: await readRemoteSettings(app, getRemoteConfig, fetchAndActivate, getValue),
    appCheck: appCheckMode(config),
  };
}

function hybridParams<T extends { inCloudParams: { model: string; systemInstruction: string }; onDeviceParams: { createOptions: object } }>(
  shared: T,
  responseSchema: ReturnType<typeof import("firebase/ai").Schema.object>,
) {
  return {
    ...shared,
    inCloudParams: {
      ...shared.inCloudParams,
      generationConfig: { maxOutputTokens: 1024, responseMimeType: "application/json" as const, responseSchema },
    },
    onDeviceParams: {
      ...shared.onDeviceParams,
      promptOptions: { responseConstraint: responseSchema },
    },
  };
}

async function turn(
  model: { generateContent: (prompt: string) => Promise<{ response: { text: () => string; inferenceSource?: unknown } }> },
  prompt: string,
): Promise<ModelTurn> {
  const result = await model.generateContent(prompt);
  return { text: result.response.text(), inferenceSource: mapInferenceSource(result.response.inferenceSource) };
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
