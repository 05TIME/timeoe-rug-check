import { z } from "zod";
import type { Verdict } from "../verdict";

const VERDICTS = ["PASS", "CAUTION", "FAIL"] as const;

const line = (min: number, max: number) => z.string().trim().min(min).max(max);
const mustBeTrue = z.union([z.literal(true), z.literal("true")]).transform(() => true as const);

export const explanationSchema = z.object({
  verdictEcho: z.enum(VERDICTS),
  headline: line(8, 180),
  plainEnglish: line(20, 900),
  whyTheseReasons: z.array(line(4, 280)).min(1).max(6),
  whatYouCanDo: z.array(line(4, 280)).min(1).max(4),
  notAdvice: mustBeTrue,
});

export const followUpSchema = z.object({
  verdictEcho: z.enum(VERDICTS),
  answer: line(8, 900),
  notAdvice: mustBeTrue,
});

export type Explanation = z.infer<typeof explanationSchema>;
export type FollowUpBody = z.infer<typeof followUpSchema>;

export type RejectCode = "invalid-json" | "schema" | "verdict-mismatch" | "unsafe";

export interface Accepted<T> { ok: true; value: T }
export interface Rejected { ok: false; code: RejectCode; message: string }

const DISCARDED = "The explanation was discarded. The verdict is unchanged.";

const TRADE_ORDER = /\b(you should|you must|i recommend|go ahead and|make sure you)\s+(buy|sell|ape into|invest in)\b/i;
const SECRET_REQUEST = /\b(share|enter|paste|send|give|reveal|type)\b[^.]{0,40}\b(seed phrase|private key|recovery phrase|secret key|mnemonic)\b/gi;

function asksForSecret(text: string): boolean {
  SECRET_REQUEST.lastIndex = 0;
  for (const match of text.matchAll(SECRET_REQUEST)) {
    const before = text.slice(Math.max(0, (match.index ?? 0) - 16), match.index ?? 0);
    if (!/\b(never|not|don't|do not)\b/i.test(before)) return true;
  }
  return false;
}
const VERDICT_OVERRIDE = /\b(?:should be|upgraded to|downgraded to|real verdict is|actually a|change (?:this|it) to)\s+(?:a\s+)?(PASS|CAUTION|FAIL)\b/i;

export function readModelJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return JSON.parse(fenced ? fenced[1] : trimmed);
}

export function safetyProblem(text: string, verdict: Verdict): RejectCode | null {
  if (TRADE_ORDER.test(text) || asksForSecret(text)) return "unsafe";
  const claim = text.match(VERDICT_OVERRIDE);
  if (claim && claim[1].toUpperCase() !== verdict) return "verdict-mismatch";
  return null;
}

function reject(code: RejectCode): Rejected {
  if (code === "verdict-mismatch") return { ok: false, code, message: `The explanation tried to state a different verdict, so it was discarded. The verdict is unchanged.` };
  if (code === "unsafe") return { ok: false, code, message: `The explanation included a trade instruction or asked for a secret, so it was discarded. The verdict is unchanged.` };
  if (code === "invalid-json") return { ok: false, code, message: `The explanation was not valid JSON, so it was discarded. The verdict is unchanged.` };
  return { ok: false, code, message: DISCARDED };
}

function screen(text: string, verdict: Verdict, echoed: Verdict): Rejected | null {
  if (echoed !== verdict) return reject("verdict-mismatch");
  const problem = safetyProblem(text, verdict);
  return problem ? reject(problem) : null;
}

export function acceptExplanation(raw: string, verdict: Verdict): Accepted<Explanation> | Rejected {
  let json: unknown;
  try { json = readModelJson(raw); }
  catch { return reject("invalid-json"); }
  const parsed = explanationSchema.safeParse(json);
  if (!parsed.success) return reject("schema");
  const value = parsed.data;
  const visible = [value.headline, value.plainEnglish, ...value.whyTheseReasons, ...value.whatYouCanDo].join("\n");
  return screen(visible, verdict, value.verdictEcho) ?? { ok: true, value };
}

export function acceptFollowUp(raw: string, verdict: Verdict): Accepted<FollowUpBody> | Rejected {
  let json: unknown;
  try { json = readModelJson(raw); }
  catch { return reject("invalid-json"); }
  const parsed = followUpSchema.safeParse(json);
  if (!parsed.success) return reject("schema");
  const blocked = screen(parsed.data.answer, verdict, parsed.data.verdictEcho);
  return blocked ?? { ok: true, value: parsed.data };
}
