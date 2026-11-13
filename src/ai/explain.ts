import type { Explanation } from "./schema";
import { acceptExplanation, acceptFollowUp } from "./schema";
import { buildExplanationPrompt, buildFollowUpPrompt, type CheckSnapshot } from "./prompt";

/** UI labels. SDK values are "on_device" and "in_cloud"; both casings are accepted. */
export type InferencePath = "ON_DEVICE" | "IN_CLOUD" | "UNKNOWN";
export type AnswerPath = InferencePath | "LOCAL";

export interface ModelTurn {
  text: string;
  inferenceSource: InferencePath;
}

/**
 * The Firebase adapter lives in client.ts. Tests pass a fake.
 * prepare() must call initializeDeviceModel, and only from a click handler.
 */
export interface Explainer {
  prepare(onDownload?: (fraction: number) => void): Promise<void>;
  explain(prompt: string): Promise<ModelTurn>;
  followUp(prompt: string): Promise<ModelTurn>;
}

export interface ExplainSettings {
  enabled: boolean;
  maxFollowUps: number;
}

export interface HybridRuntime {
  explainer: Explainer;
  settings: ExplainSettings;
  appCheck: "recaptcha" | "debug" | "missing";
}

export const DEFAULT_EXPLAIN_SETTINGS: ExplainSettings = { enabled: true, maxFollowUps: 4 };

export type ExplainOutcome =
  | { ok: true; explanation: Explanation; path: InferencePath }
  | { ok: false; message: string; code: string; path?: InferencePath };

export type FollowUpOutcome =
  | { ok: true; answer: string; path: AnswerPath }
  | { ok: false; message: string; code: string; path?: InferencePath };

export function mapInferenceSource(value: unknown): InferencePath {
  if (value === "on_device" || value === "ON_DEVICE") return "ON_DEVICE";
  if (value === "in_cloud" || value === "IN_CLOUD") return "IN_CLOUD";
  return "UNKNOWN";
}

export function pathLabel(path: AnswerPath): string {
  if (path === "ON_DEVICE") return "On this device · Gemini Nano";
  if (path === "IN_CLOUD") return "Cloud · Gemini";
  if (path === "LOCAL") return "Answered here · no model call";
  return "Path not reported";
}

export function pathDetail(path: AnswerPath): string {
  if (path === "ON_DEVICE") return "Ran on this device with Gemini Nano. This explanation did not leave the browser.";
  if (path === "IN_CLOUD") return "Ran in the cloud with Gemini. This browser had no ready on-device model, so Firebase AI Logic used the cloud fallback.";
  if (path === "LOCAL") return "Blocked in the browser before any model saw the question.";
  return "The model answered, but did not report whether it ran on-device or in the cloud.";
}

export function downloadPercent(fraction: number): number {
  if (!Number.isFinite(fraction)) return 0;
  return Math.max(0, Math.min(100, Math.round(fraction * 100)));
}

/** Remote Config values arrive as strings. Missing or blank falls back to the defaults. */
export function settingsFromRemote(values: { explain_enabled?: string; max_followups?: string }): ExplainSettings {
  const enabledRaw = values.explain_enabled?.trim().toLowerCase();
  const enabled = enabledRaw === undefined || enabledRaw === "" ? DEFAULT_EXPLAIN_SETTINGS.enabled : enabledRaw === "true" || enabledRaw === "1" || enabledRaw === "yes";
  const parsed = Number(values.max_followups);
  const maxFollowUps = values.max_followups === undefined || values.max_followups.trim() === "" || !Number.isFinite(parsed)
    ? DEFAULT_EXPLAIN_SETTINGS.maxFollowUps
    : Math.max(0, Math.min(8, Math.floor(parsed)));
  return { enabled, maxFollowUps };
}

const SECRET_REQUEST = /\b(show|give|share|enter|paste|send|reveal|dump|extract)\b[\s\S]{0,40}\b(seed phrase|private key|recovery phrase|secret key|mnemonic)\b|\b(seed phrase|private key|recovery phrase|secret key|mnemonic)\b[\s\S]{0,40}\b(show|give|share|enter|paste|send|reveal|dump|extract)\b/i;

export function prepareQuestion(raw: string): { ok: true; question: string; localAnswer?: string } | { ok: false; message: string } {
  const question = raw.trim().replace(/\s+/g, " ");
  if (question.length < 3 || question.length > 500) {
    return { ok: false, message: "Ask a question of a few words, up to a short paragraph. The verdict is unchanged." };
  }
  if (SECRET_REQUEST.test(question)) {
    return {
      ok: true,
      question,
      localAnswer: "TIMEŒ Rug Check never asks for a seed phrase or private key, and this explainer will not collect one. The verdict is unchanged.",
    };
  }
  return { ok: true, question };
}

export function classifyModelError(err: unknown): { message: string; code: "model-error" } {
  const raw = err instanceof Error ? err.message : String(err ?? "");
  if (/app ?check|permission-denied|unauthenticated|\b401\b|\b403\b/i.test(raw)) {
    return {
      code: "model-error",
      message: "Firebase rejected the cloud fallback. In Chrome on a computer, Gemini Nano can still explain once the on-device model is ready. The verdict is unchanged.",
    };
  }
  return { code: "model-error", message: "The explainer could not answer. The verdict is unchanged." };
}

export async function explainVerdict(
  check: CheckSnapshot,
  explainer: Explainer,
  hooks?: { onDownload?: (fraction: number) => void; onGenerateStart?: () => void },
): Promise<ExplainOutcome> {
  try {
    await explainer.prepare(hooks?.onDownload);
    hooks?.onGenerateStart?.();
    const turn = await explainer.explain(buildExplanationPrompt(check));
    const accepted = acceptExplanation(turn.text, check.verdict);
    if (!accepted.ok) return { ok: false, message: accepted.message, code: accepted.code, path: turn.inferenceSource };
    return { ok: true, explanation: accepted.value, path: turn.inferenceSource };
  } catch (err) {
    return { ok: false, ...classifyModelError(err) };
  }
}

export async function answerFollowUp(input: {
  check: CheckSnapshot;
  explanation: Explanation;
  history: { question: string; answer: string }[];
  question: string;
  explainer: Explainer;
}): Promise<FollowUpOutcome> {
  const prepared = prepareQuestion(input.question);
  if (!prepared.ok) return { ok: false, message: prepared.message, code: "question" };
  if (prepared.localAnswer) return { ok: true, answer: prepared.localAnswer, path: "LOCAL" };
  try {
    await input.explainer.prepare();
    const turn = await input.explainer.followUp(buildFollowUpPrompt({
      check: input.check,
      explanation: input.explanation,
      history: input.history,
      question: prepared.question,
    }));
    const accepted = acceptFollowUp(turn.text, input.check.verdict);
    if (!accepted.ok) return { ok: false, message: accepted.message, code: accepted.code, path: turn.inferenceSource };
    return { ok: true, answer: accepted.value.answer, path: turn.inferenceSource };
  } catch (err) {
    return { ok: false, ...classifyModelError(err) };
  }
}
