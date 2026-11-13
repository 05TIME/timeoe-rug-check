import type { Verdict } from "../verdict";

/** Cloud fallback. This is the Firebase AI Logic hybrid default from JS SDK 13. */
export const CLOUD_FALLBACK_MODEL = "gemini-3.5-flash-lite";

/**
 * Shared safety rules. Kept short because Chrome never evicts the system prompt
 * from Gemini Nano's context window.
 * On-device hybrid inference does not support multi-turn chat, so follow-ups are
 * new single-turn prompts.
 */
const RULES = "Explain a fixed token rug-check. Copy its verdict into verdictEcho. The model can never alter the verdict. Do not change it, invent facts, recommend a trade, or ask for a wallet or seed phrase. notAdvice is true. JSON only.";

export const EXPLAIN_SYSTEM = `${RULES} Keys: verdictEcho, headline, plainEnglish, whyTheseReasons, whatYouCanDo, notAdvice.`;
export const FOLLOW_SYSTEM = `${RULES} Keys: verdictEcho, answer, notAdvice.`;

/** User-turn budget. Nano's context window also holds the system prompt and the JSON constraint. */
export const ON_DEVICE_USER_PROMPT_MAX = 900;

export interface CheckSnapshot {
  mint: string;
  name?: string;
  symbol?: string;
  verdict: Verdict;
  reasons: string[];
  sources: { name: string; ok: boolean }[];
  checkedAt: string;
  /** Same as mint; set for EVM tokens too. */
  address?: string;
  chain?: { name: string };
  /** Short server-made fact lines (market, holders, contract flags). Facts only; the verdict stays fixed. */
  facts?: string[];
}

export interface ExplanationFacts {
  headline: string;
  plainEnglish: string;
  whyTheseReasons: string[];
  whatYouCanDo: string[];
}

const HISTORY_LIMIT = 3;

export function clip(value: string, max: number): string {
  const trimmed = value.trim().replace(/\s+/g, " ");
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, Math.max(0, max - 1))}…`;
}

/** Hard cap so a long reason list cannot overflow Gemini Nano by itself. */
export function limitPrompt(text: string, max = ON_DEVICE_USER_PROMPT_MAX): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

function tokenLine(check: CheckSnapshot): string {
  const name = check.name ? clip(check.name, 40) : "";
  const symbol = check.symbol ? `(${clip(check.symbol, 16)})` : "";
  const label = [name, symbol].filter(Boolean).join(" ");
  return label ? `Token: ${label}` : "Token: name unknown";
}

function sourceLine(check: CheckSnapshot): string {
  if (!check.sources.length) return "Sources: none";
  return clip(`Sources: ${check.sources.map((s) => `${s.name} ${s.ok ? "ok" : "unavailable"}`).join(", ")}`, 180);
}

/**
 * Adds as many fact lines as fit in `budget` characters (including newlines).
 * Facts are the lowest-priority part of the prompt, so they are dropped first.
 */
export function factBlock(check: CheckSnapshot, budget: number): string {
  const facts = (check.facts ?? []).map((f) => clip(f, 90)).filter(Boolean);
  if (!facts.length || budget < 20) return "";
  const out: string[] = ["Facts:"];
  let used = "Facts:".length;
  for (const f of facts.slice(0, 10)) {
    const line = `- ${f}`;
    if (used + 1 + line.length > budget) break;
    out.push(line); used += 1 + line.length;
  }
  return out.length > 1 ? out.join("\n") : "";
}

/**
 * Assembles head + reasons + facts + tail within the on-device budget.
 * Facts are dropped first, then the lowest-priority reasons, so the tail (sources or the question) survives.
 */
function withFacts(head: string[], check: CheckSnapshot, tail: string[]): string {
  const reasons = check.reasons.slice(0, 6).map((reason) => `- ${clip(reason, 100)}`);
  const join = (r: string[], facts = "") => [...head, "Reasons:", ...r, facts, ...tail].filter(Boolean).join("\n");
  while (reasons.length > 1 && join(reasons).length > ON_DEVICE_USER_PROMPT_MAX) reasons.pop();
  const facts = factBlock(check, ON_DEVICE_USER_PROMPT_MAX - join(reasons).length - 1);
  return limitPrompt(join(reasons, facts));
}

export function buildExplanationPrompt(check: CheckSnapshot): string {
  return withFacts([
    `Verdict (fixed): ${check.verdict}`,
    "Do not change the verdict.",
    tokenLine(check),
    check.chain ? `Chain: ${clip(check.chain.name, 24)}` : "",
    `Address: ${check.address ?? check.mint}`,
  ], check, [sourceLine(check)]);
}

export function buildFollowUpPrompt(input: {
  check: CheckSnapshot;
  explanation: ExplanationFacts;
  history: { question: string; answer: string }[];
  question: string;
}): string {
  const history = input.history.slice(-HISTORY_LIMIT).map((turn, i) =>
    `Q${i + 1}: ${clip(turn.question, 80)}\nA${i + 1}: ${clip(turn.answer, 100)}`).join("\n");
  return withFacts([
    "This is a single question, not a chat.",
    `Verdict (fixed): ${input.check.verdict}`,
    "Do not change the verdict.",
    tokenLine(input.check),
  ], input.check, [
    `Accepted: ${clip(input.explanation.headline, 80)} ${clip(input.explanation.plainEnglish, 140)}`,
    history,
    `Question: ${clip(input.question.trim(), 160)}`,
  ]);
}
