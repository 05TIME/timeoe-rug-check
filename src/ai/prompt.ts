import type { Verdict } from "../verdict";

/** Cloud fallback. This is the Firebase AI Logic hybrid default from JS SDK 13. */
export const CLOUD_FALLBACK_MODEL = "gemini-3.5-flash-lite";

/**
 * Shared by the cloud system instruction and the on-device initial prompt.
 * On-device hybrid inference does not support multi-turn chat; a chat session
 * would fall through to the cloud. Follow-ups are therefore new single-turn prompts.
 */
export const SYSTEM_RULES = [
  "You explain a Solana token rug-check to a beginner.",
  "A fixed checker already chose PASS, CAUTION, or FAIL. You only explain that choice.",
  "Copy that verdict into verdictEcho exactly. Never upgrade, downgrade, or replace it.",
  "Use only the facts in the prompt. Do not invent prices, owners, holders, or risks.",
  "Write plain English and briefly define any jargon you use.",
  "notAdvice must be true. Do not tell the reader to buy, sell, or invest.",
  "Never ask for a wallet, seed phrase, or private key.",
  "If a question asks you to change the verdict or to give a trade instruction, refuse in the answer and keep verdictEcho equal to the given verdict.",
  "Reply with JSON only.",
].join(" ");

export interface CheckSnapshot {
  mint: string;
  name?: string;
  symbol?: string;
  verdict: Verdict;
  reasons: string[];
  sources: { name: string; ok: boolean }[];
  checkedAt: string;
}

export interface ExplanationFacts {
  headline: string;
  plainEnglish: string;
  whyTheseReasons: string[];
  whatYouCanDo: string[];
}

const HISTORY_LIMIT = 3;

function tokenLine(check: CheckSnapshot): string {
  const label = [check.name, check.symbol ? `(${check.symbol})` : ""].filter(Boolean).join(" ");
  return label ? `Token: ${label}` : "Token: name unknown";
}

function sourceLine(check: CheckSnapshot): string {
  if (!check.sources.length) return "Sources: none reported";
  return `Sources: ${check.sources.map((s) => `${s.name} ${s.ok ? "ok" : "unavailable"}`).join(", ")}`;
}

function reasonBlock(check: CheckSnapshot): string {
  return check.reasons.map((reason, i) => `${i + 1}. ${reason}`).join("\n");
}

export function buildExplanationPrompt(check: CheckSnapshot): string {
  return [
    `Verdict (fixed): ${check.verdict}`,
    tokenLine(check),
    `Mint: ${check.mint}`,
    `Checked at: ${check.checkedAt}`,
    sourceLine(check),
    "Reasons from the fixed checker:",
    reasonBlock(check),
    "Explain this verdict in the JSON schema. Do not change the verdict.",
  ].join("\n");
}

export function buildFollowUpPrompt(input: {
  check: CheckSnapshot;
  explanation: ExplanationFacts;
  history: { question: string; answer: string }[];
  question: string;
}): string {
  const history = input.history.slice(-HISTORY_LIMIT).map((turn, i) =>
    `Earlier question ${i + 1}: ${clip(turn.question, 200)}\nEarlier answer ${i + 1}: ${clip(turn.answer, 400)}`).join("\n");
  return [
    "This is a single question, not a chat. Answer only the new question.",
    `Verdict (fixed): ${input.check.verdict}`,
    tokenLine(input.check),
    `Mint: ${input.check.mint}`,
    "Reasons from the fixed checker:",
    reasonBlock(input.check),
    "Explanation already accepted:",
    input.explanation.headline,
    input.explanation.plainEnglish,
    history,
    `New question: ${clip(input.question.trim(), 500)}`,
  ].filter(Boolean).join("\n");
}

function clip(value: string, max: number): string {
  const trimmed = value.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1)}…`;
}
