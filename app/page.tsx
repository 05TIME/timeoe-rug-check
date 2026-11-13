"use client";
import { useState, type FormEvent } from "react";
import ExplainPanel from "./explain-panel";

type Result = { mint: string; name?: string; symbol?: string; verdict: "PASS" | "CAUTION" | "FAIL"; reasons: string[]; sources: { name: string; ok: boolean }[]; checkedAt: string };

const LABEL = { PASS: "PASS: no red flags found", CAUTION: "CAUTION", FAIL: "FAIL: red flags found" };

export default function Page() {
  const [mint, setMint] = useState("");
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<Result | null>(null);
  const [err, setErr] = useState("");

  async function onSubmit(e: FormEvent) {
    e.preventDefault(); setBusy(true); setErr(""); setRes(null);
    try {
      const r = await fetch(`/api/check?mint=${encodeURIComponent(mint.trim())}`);
      const j = await r.json();
      if (!r.ok) setErr(j.error ?? "Something went wrong."); else setRes(j);
    } catch { setErr("Network problem. Please try again."); }
    finally { setBusy(false); }
  }

  return (
    <main>
      <h1>TIMEŒ Rug Check</h1>
      <p className="sub">Paste a Solana token mint address for a plain-language risk check. Free and read-only. The verdict comes from fixed checks. An optional explanation can translate it and never changes it.</p>
      <form onSubmit={onSubmit}>
        <input value={mint} onChange={(e) => setMint(e.target.value)} placeholder="Token mint address" aria-label="Token mint address"
          autoCapitalize="off" autoCorrect="off" autoComplete="off" spellCheck={false} inputMode="text" />
        <button type="submit" disabled={busy || !mint.trim()}>{busy ? "Checking…" : "Check"}</button>
      </form>
      {err && <p className="err" role="alert">{err}</p>}
      {res && (
        <section className="card" aria-live="polite">
          <span className={`badge ${res.verdict}`}>{LABEL[res.verdict]}</span>
          {(res.name || res.symbol) && <h2>{res.name}{res.symbol ? ` (${res.symbol})` : ""}</h2>}
          <p className="mint">{res.mint}</p>
          <ul>{res.reasons.map((r) => <li key={r}>{r}</li>)}</ul>
          <p className="small">Sources: {res.sources.map((s) => `${s.name}${s.ok ? "" : " (unavailable)"}`).join(", ")}</p>
          <p className="small">Checked {new Date(res.checkedAt).toLocaleString()}</p>
        </section>
      )}
      {res && <ExplainPanel key={`${res.mint}-${res.checkedAt}`} result={res} />}
      <section className="card disclaimer">
        <p><strong>Not financial advice.</strong> TIMEŒ Rug Check is a free, automated tool that reads public blockchain and market data and applies simple heuristics. Results can be wrong, incomplete or out of date, and a &quot;PASS&quot; does not mean a token is safe or a good investment. Always do your own research and never invest more than you can afford to lose. No liability is accepted for decisions made using this tool.</p>
        <p><strong>TIMEŒ Rug Check will never ask you to connect a wallet, share a seed phrase or private key, or send funds.</strong></p>
      </section>
    </main>
  );
}
