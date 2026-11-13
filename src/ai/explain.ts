import type { Explanation } from "./schema";
import { acceptExplanation, acceptFollowUp } from "./schema";
import { buildExplanationPrompt, buildFollowUpPrompt, type CheckSnapshot } from "./prompt";

/** UI labels. SDK values are "on_device" and "in_cloud"; both casings are accepted. */
export type InferencePath = "ON_DEVICE" | "IN_CLOUD" | "UNKNOWN";
export type AnswerPath = InferencePath | "LOCAL";

export interface ModelTurn {
  text: string;
  inferenceSource: InferencePath;
  /** Set when Nano rejected the input and the cloud model answered instead. */
  fallbackReason?: "input-too-large";
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
  appCheck: "enterprise" | "debug" | "missing";
}

export const DEFAULT_EXPLAIN_SETTINGS: ExplainSettings = { enabled: true, maxFollowUps: 4 };

export function followUpsRemaining(maxFollowUps: number, asked: number): number {
  const max = Number.isFinite(maxFollowUps) ? Math.max(0, Math.floor(maxFollowUps)) : DEFAULT_EXPLAIN_SETTINGS.maxFollowUps;
  const used = Number.isFinite(asked) ? Math.max(0, Math.floor(asked)) : 0;
  return Math.max(0, max - used);
}

/** Copy for the explanation card. Remote Config supplies maxFollowUps; the default is 4. */
export function followUpsLeftLabel(maxFollowUps: number, asked: number): string {
  const left = followUpsRemaining(maxFollowUps, asked);
  return left === 1 ? "1 follow-up question left" : `${left} follow-up questions left`;
}

export type ExplainOutcome =
  | { ok: true; explanation: Explanation; path: InferencePath; fallbackReason?: "input-too-large" }
  | { ok: false; message: string; code: string; path?: InferencePath };

export type FollowUpOutcome =
  | { ok: true; answer: string; path: AnswerPath; fallbackReason?: "input-too-large" }
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

export function pathDetail(path: AnswerPath, fallbackReason?: "input-too-large"): string {
  if (path === "ON_DEVICE") return "Ran on this device with Gemini Nano. This explanation did not leave the browser.";
  if (path === "IN_CLOUD" && fallbackReason === "input-too-large") {
    return "Ran in the cloud with Gemini. Gemini Nano rejected this input as too large, so Firebase AI Logic answered in the cloud instead.";
  }
  if (path === "IN_CLOUD") return "Ran in the cloud with Gemini. This browser had no ready on-device model, so Firebase AI Logic used the cloud fallback.";
  if (path === "LOCAL") return "Blocked in the browser before any model saw the question.";
  return "The model answered, but did not report whether it ran on-device or in the cloud.";
}

export function downloadPercent(fraction: number): number {
  if (!Number.isFinite(fraction)) return 0;
  return Math.max(0, Math.min(100, Math.round(fraction * 100)));
}

/**
 * Chrome throws QuotaExceededError (DOMException code 22) when a prompt, including
 * the system prompt and response schema, does not fit Gemini Nano's context window.
 * Firebase's PREFER_ON_DEVICE mode does not catch that error, so we do.
 */
export function isInputTooLarge(err: unknown): boolean {
  if (typeof err === "string") return /input is too large|quotaexceeded/i.test(err);
  if (!err || typeof err !== "object") return false;
  const candidate = err as { name?: unknown; message?: unknown; code?: unknown };
  const name = typeof candidate.name === "string" ? candidate.name : "";
  const message = typeof candidate.message === "string" ? candidate.message : "";
  if (name === "QuotaExceededError") return true;
  if (/input is too large|quotaexceeded/i.test(message)) return true;
  return candidate.code === 22 && /quota|too large/i.test(`${name} ${message}`);
}

/** True when a measured prompt uses more of the context window than Nano has left. */
export function contextWouldOverflow(usage: number, windowSize: number): boolean {
  if (!Number.isFinite(usage) || !Number.isFinite(windowSize)) return false;
  if (windowSize < 0) return true;
  return usage > windowSize;
}

export async function withOnDeviceFallback(args: {
  measure?: () => Promise<{ usage: number; windowSize: number } | null>;
  runOnDevice: () => Promise<ModelTurn>;
  runInCloud: () => Promise<ModelTurn>;
}): Promise<ModelTurn> {
  const useCloud = async (): Promise<ModelTurn> => {
    const cloud = await args.runInCloud();
    return { ...cloud, inferenceSource: "IN_CLOUD", fallbackReason: "input-too-large" };
  };
  if (args.measure) {
    try {
      const measured = await args.measure();
      if (measured && contextWouldOverflow(measured.usage, measured.windowSize)) return useCloud();
    } catch (err) {
      if (isInputTooLarge(err)) return useCloud();
    }
  }
  try {
    return await args.runOnDevice();
  } catch (err) {
    if (!isInputTooLarge(err)) throw err;
    return useCloud();
  }
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

export const VERDICT_OVERRIDE_REFUSAL = "I can't change the verdict. It comes from on-chain checks, not the AI.";

/** Asks what a different verdict would require. These still go to the model. */
const VERDICT_CONDITION_QUESTION = /\b(what|how|why)\b[\s\S]{0,60}\b(would|could|can|does|do|to|mean|means)\b/i;
const COMMAND_TO_OVERRIDE = /\b(ignore|override|change\s+(this|it|the)|mark\s+it|say\s+it|give\s+(me\s+)?(a\s+)?(pass|fail|caution))\b/i;
const VERDICT_OVERRIDE = /\bchange\b[\s\S]{0,40}\bto\b[\s\S]{0,24}\b(pass|caution|fail|green|safe)\b|\b(mark|label|set|switch|turn|flip)\b[\s\S]{0,30}\b(safe|green|pass|passes|caution|fail)\b|\bsay\b[\s\S]{0,30}\b(it |this )?(passes|is safe|is a pass|pass|green)\b|\bignore\b[\s\S]{0,60}\b(rules|rule|checker|checks|verdict)\b|\b(give|grant)\b[\s\S]{0,24}\b(me )?(a )?(pass|fail|caution|green)\b|\bmake\b[\s\S]{0,40}\b(verdict|badge|result|check)\b[\s\S]{0,24}\b(green|red|pass|fail|safe|caution)\b|\bmake\b[\s\S]{0,16}\b(it|this)\b[\s\S]{0,16}\b(green|safe|pass|a pass)\b|\boverride\b/i;

export function asksToOverrideVerdict(question: string): boolean {
  if (VERDICT_CONDITION_QUESTION.test(question) && !COMMAND_TO_OVERRIDE.test(question)) return false;
  return VERDICT_OVERRIDE.test(question);
}

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
  if (asksToOverrideVerdict(question)) {
    return { ok: true, question, localAnswer: VERDICT_OVERRIDE_REFUSAL };
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
    return { ok: true, explanation: accepted.value, path: turn.inferenceSource, fallbackReason: turn.fallbackReason };
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
    return { ok: true, answer: accepted.value.answer, path: turn.inferenceSource, fallbackReason: turn.fallbackReason };
  } catch (err) {
    return { ok: false, ...classifyModelError(err) };
  }
}
