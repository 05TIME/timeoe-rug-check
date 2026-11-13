/**
 * Public Firebase web config. These values are not secret (App Check protects
 * the Gemini API), but they must come from the environment, never the repo.
 *
 * Next.js only inlines NEXT_PUBLIC_ variables that are referenced by their full
 * name, so each one is read explicitly below.
 */
export interface FirebasePublicConfig {
  apiKey: string;
  authDomain: string;
  projectId: string;
  appId: string;
  storageBucket?: string;
  messagingSenderId?: string;
  /**
   * reCAPTCHA Enterprise site key (Fraud Defense, score-based, no checkbox).
   * The Enterprise env var wins. The classic variable is only a name fallback
   * for a key already stored under the old name. Either value is passed to
   * ReCaptchaEnterpriseProvider. A classic reCAPTCHA v3 key will not attest.
   */
  appCheckSiteKey?: string;
  /** Local demo only. Never set this on the production deployment. */
  appCheckDebugToken?: string;
}

export type AppCheckMode = "enterprise" | "debug" | "missing";

type Env = Record<string, string | undefined>;

function filled(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/** The env object Next will inline into the browser bundle. */
export function firebasePublicEnv(): Env {
  return {
    NEXT_PUBLIC_FIREBASE_API_KEY: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
    NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
    NEXT_PUBLIC_FIREBASE_PROJECT_ID: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
    NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
    NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
    NEXT_PUBLIC_FIREBASE_APP_ID: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
    NEXT_PUBLIC_FIREBASE_APPCHECK_RECAPTCHA_ENTERPRISE_SITE_KEY: process.env.NEXT_PUBLIC_FIREBASE_APPCHECK_RECAPTCHA_ENTERPRISE_SITE_KEY,
    NEXT_PUBLIC_FIREBASE_APPCHECK_RECAPTCHA_SITE_KEY: process.env.NEXT_PUBLIC_FIREBASE_APPCHECK_RECAPTCHA_SITE_KEY,
    NEXT_PUBLIC_FIREBASE_APPCHECK_DEBUG_TOKEN: process.env.NEXT_PUBLIC_FIREBASE_APPCHECK_DEBUG_TOKEN,
  };
}

/** Null means the AI layer stays off and the deterministic check still runs. */
export function readFirebasePublicConfig(env: Env = firebasePublicEnv()): FirebasePublicConfig | null {
  const apiKey = filled(env.NEXT_PUBLIC_FIREBASE_API_KEY);
  const authDomain = filled(env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN);
  const projectId = filled(env.NEXT_PUBLIC_FIREBASE_PROJECT_ID);
  const appId = filled(env.NEXT_PUBLIC_FIREBASE_APP_ID);
  if (!apiKey || !authDomain || !projectId || !appId) return null;
  return {
    apiKey,
    authDomain,
    projectId,
    appId,
    storageBucket: filled(env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET),
    messagingSenderId: filled(env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID),
    appCheckSiteKey: filled(env.NEXT_PUBLIC_FIREBASE_APPCHECK_RECAPTCHA_ENTERPRISE_SITE_KEY)
      ?? filled(env.NEXT_PUBLIC_FIREBASE_APPCHECK_RECAPTCHA_SITE_KEY),
    appCheckDebugToken: filled(env.NEXT_PUBLIC_FIREBASE_APPCHECK_DEBUG_TOKEN),
  };
}

export function appCheckMode(config: FirebasePublicConfig): AppCheckMode {
  if (config.appCheckSiteKey) return "enterprise";
  if (config.appCheckDebugToken) return "debug";
  return "missing";
}
