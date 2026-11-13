"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { appCheckMode, readFirebasePublicConfig } from "../src/ai/config";
import { startHybridAi } from "../src/ai/client";
import {
  answerFollowUp,
  DEFAULT_EXPLAIN_SETTINGS,
  downloadPercent,
  explainVerdict,
  followUpsLeftLabel,
  followUpsRemaining,
  pathDetail,
  pathLabel,
  type AnswerPath,
  type ExplainSettings,
  type Explainer,
} from "../src/ai/explain";
import type { CheckSnapshot } from "../src/ai/prompt";
import type { Explanation } from "../src/ai/schema";

interface ThreadItem {
  question: string;
  answer: string;
  path: AnswerPath;
  fallbackReason?: "input-too-large";
}

export default function ExplainPanel({ result }: { result: CheckSnapshot }) {
  const config = readFirebasePublicConfig();
  const explainerRef = useRef<Explainer | null>(null);
  const live = useRef(true);
  const busyRef = useRef(false);
  const configured = config !== null;
  const [settings, setSettings] = useState<ExplainSettings>(DEFAULT_EXPLAIN_SETTINGS);
  const [ready, setReady] = useState(false);
  const [bootError, setBootError] = useState("");
  const [phase, setPhase] = useState<"idle" | "device" | "writing" | "answering">("idle");
  const [progress, setProgress] = useState<number | null>(null);
  const [explanation, setExplanation] = useState<Explanation | null>(null);
  const [path, setPath] = useState<AnswerPath | null>(null);
  const [fallbackReason, setFallbackReason] = useState<"input-too-large" | undefined>();
  const [error, setError] = useState("");
  const [question, setQuestion] = useState("");
  const [thread, setThread] = useState<ThreadItem[]>([]);

  useEffect(() => {
    live.current = true;
    return () => { live.current = false; };
  }, []);

  useEffect(() => {
    if (!configured) return;
    let cancelled = false;
    startHybridAi().then((runtime) => {
      if (cancelled) return;
      explainerRef.current = runtime.explainer;
      setSettings(runtime.settings);
      setReady(true);
    }).catch(() => {
      if (cancelled) return;
      setBootError("The explainer could not start. The verdict above is unchanged.");
      setReady(true);
    });
    return () => { cancelled = true; };
  }, [configured]);

  if (!config) {
    return (
      <section className="card ai" aria-label="Plain-English explanation">
        <h2>Plain-English explanation</h2>
        <p className="notice">Plain-English explanations are off because Firebase is not configured. The verdict above comes only from the fixed checks and did not use AI.</p>
      </section>
    );
  }

  const appCheck = appCheckMode(config);
  const modelAnswers = thread.filter((item) => item.path !== "LOCAL").length;
  const followUpsLeft = followUpsRemaining(settings.maxFollowUps, modelAnswers);
  const followUpsLabel = followUpsLeftLabel(settings.maxFollowUps, modelAnswers);
  const busy = phase === "device" || phase === "writing" || phase === "answering";

  async function onExplain() {
    const explainer = explainerRef.current;
    if (!explainer || busyRef.current) return;
    busyRef.current = true;
    setError("");
    setPhase("device");
    setProgress(null);
    try {
      const outcome = await explainVerdict(result, explainer, {
        onDownload: (fraction) => { if (live.current) setProgress(downloadPercent(fraction)); },
        onGenerateStart: () => { if (live.current) setPhase("writing"); },
      });
      if (!live.current) return;
      if (!outcome.ok) { setError(outcome.message); return; }
      setExplanation(outcome.explanation);
      setPath(outcome.path);
      setFallbackReason(outcome.fallbackReason);
    } finally {
      busyRef.current = false;
      if (live.current) { setPhase("idle"); setProgress(null); }
    }
  }

  async function onAsk(event: FormEvent) {
    event.preventDefault();
    const explainer = explainerRef.current;
    if (!explainer || !explanation || busyRef.current || followUpsLeft <= 0) return;
    busyRef.current = true;
    setError("");
    setPhase("answering");
    try {
      const outcome = await answerFollowUp({
        check: result,
        explanation,
        history: thread.map(({ question: q, answer }) => ({ question: q, answer })),
        question,
        explainer,
      });
      if (!live.current) return;
      if (!outcome.ok) { setError(outcome.message); return; }
      setThread((prev) => [...prev, { question: question.trim(), answer: outcome.answer, path: outcome.path, fallbackReason: outcome.fallbackReason }]);
      setQuestion("");
    } finally {
      busyRef.current = false;
      if (live.current) setPhase("idle");
    }
  }

  return (
    <section className="card ai" aria-label="Plain-English explanation">
      <h2>Plain-English explanation</h2>
      <p className="notice">This only translates the {result.verdict} verdict. It cannot change it. On desktop Chrome it stays on this device when Gemini Nano is available.</p>
      {appCheck === "missing" && <p className="notice">App Check is not set. On-device Gemini Nano can still run in desktop Chrome. The cloud fallback will be rejected until App Check is configured.</p>}
      {bootError && <p className="err" role="alert">{bootError}</p>}
      {!bootError && !settings.enabled && !explanation && (
        <p className="notice">Explanations are switched off in Firebase Remote Config (explain_enabled). The verdict above did not use AI.</p>
      )}
      {!bootError && settings.enabled && <p className="small">{followUpsLabel}</p>}
      {!bootError && settings.enabled && !explanation && (
        <button type="button" className="secondary" onClick={onExplain} disabled={!ready || busy} aria-busy={busy}>
          {phase === "device" ? `Preparing the on-device model${progress === null ? "…" : `… ${progress}%`}` : phase === "writing" ? "Writing the explanation…" : "Explain this verdict"}
        </button>
      )}
      {explanation && path && (
        <div aria-live="polite">
          <p className={`path ${path}`}>{pathLabel(path)}</p>
          <p className="small">{pathDetail(path, fallbackReason)}</p>
          <h3>{explanation.headline}</h3>
          <p>{explanation.plainEnglish}</p>
          <ul>{explanation.whyTheseReasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>
          <p className="small">What you can do</p>
          <ul>{explanation.whatYouCanDo.map((step) => <li key={step}>{step}</li>)}</ul>
          <p className="small">This text does not change the {result.verdict} verdict and is not financial advice.</p>
        </div>
      )}
      {thread.length > 0 && (
        <ul className="qa">
          {thread.map((item, index) => (
            <li key={`${index}-${item.question}`}>
              <p><strong>You asked: </strong>{item.question}</p>
              <p>{item.answer}</p>
              <p className="small">{pathLabel(item.path)}. {pathDetail(item.path, item.fallbackReason)}</p>
            </li>
          ))}
        </ul>
      )}
      {error && <p className="err" role="alert">{error}</p>}
      {explanation && followUpsLeft > 0 && (
        <form onSubmit={onAsk}>
          <input value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="Ask what a reason means" aria-label="Follow-up question" maxLength={500} />
          <button type="submit" className="secondary" disabled={busy || question.trim().length < 3}>{phase === "answering" ? "Answering…" : "Ask"}</button>
        </form>
      )}
      {explanation && followUpsLeft <= 0 && <p className="small">{followUpsLabel}. The verdict is unchanged.</p>}
    </section>
  );
}
