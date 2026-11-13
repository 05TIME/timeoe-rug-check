"use client";
import { useState, type FormEvent } from "react";
import ExplainPanel from "./explain-panel";
import { CHAINS, EVM_CHAINS, detectAddress, type ChainKey } from "../src/chains";
import type { PublicResult } from "../src/server/check";
import type { SecurityFlag } from "../src/server/report";
import { age, count, pct, usd } from "../src/format";

type Result = PublicResult;

const LABEL = { PASS: "PASS: no red flags found", CAUTION: "CAUTION", FAIL: "FAIL: red flags found" };
const ICON: Record<SecurityFlag["state"], string> = { ok: "✓", warn: "!", bad: "✕", unknown: "?" };

function Row({ k, v }: { k: string; v: string }) {
  return <div className="row"><dt>{k}</dt><dd className={v === "unavailable" ? "na" : ""}>{v}</dd></div>;
}

function Report({ res }: { res: Result }) {
  const r = res.report;
  if (!r) return null;
  const m = r.market;
  const ok = (name: string) => res.sources.find((s) => s.name === name)?.ok !== false;
  return (
    <>
      <section className="card section" aria-label="Overview and market">
        <h3>Overview &amp; market</h3>
        {m && m.pairs > 0 ? (
          <dl>
            <Row k="Price" v={usd(m.priceUsd)} />
            <Row k="24h change" v={m.priceChange24hPct === undefined ? "unavailable" : `${m.priceChange24hPct}%`} />
            <Row k="Market cap" v={usd(m.marketCapUsd)} />
            <Row k="Fully diluted value" v={usd(m.fdvUsd)} />
            <Row k="Liquidity (all pools)" v={usd(m.totalLiquidityUsd)} />
            <Row k="Liquidity (main pool)" v={usd(m.liquidityUsd)} />
            <Row k="24h volume" v={usd(m.volume24hUsd)} />
            <Row k="24h trades" v={m.buys24h === undefined ? "unavailable" : `${count(m.buys24h)} buys / ${count(m.sells24h)} sells`} />
            <Row k="Main pool" v={`${m.dex ?? "unknown DEX"}${m.quoteSymbol ? ` · paired with ${m.quoteSymbol}` : ""}`} />
            <Row k="Pool age" v={age(m.poolAgeHours)} />
            <Row k="Pools found" v={count(m.pairs)} />
          </dl>
        ) : <p className="notice">{ok("DexScreener") ? "No trading pools found." : "Market data unavailable right now."}</p>}
      </section>

      <section className="card section" aria-label="Security flags">
        <h3>Security flags</h3>
        {r.security.length ? (
          <ul className="flags">
            {r.security.map((f) => (
              <li key={f.label} className={`flag ${f.state}`}><span className="dot" aria-hidden>{ICON[f.state]}</span>{f.label}
                {f.detail && <span className="small mono"> {f.detail}</span>}</li>
            ))}
          </ul>
        ) : <p className="notice">Security data unavailable.</p>}
        {r.token.trusted && <p className="small">GoPlus lists this token as a known, trusted token.</p>}
      </section>

      <section className="card section" aria-label="Holders and liquidity">
        <h3>Holders &amp; liquidity</h3>
        <dl>
          <Row k="Holders" v={count(r.holders.holderCount)} />
          <Row k="Top 10 holders' share" v={pct(r.holders.top10Share)} />
          {res.chain.family === "evm" && <Row k="Creator's share" v={pct(r.holders.creatorShare)} />}
          {res.chain.family === "evm" && <Row k="LP locked or burned" v={pct(r.holders.lpLockedShare)} />}
          {r.token.listedOnCex?.length ? <Row k="Listed on" v={r.token.listedOnCex.join(", ")} /> : null}
        </dl>
        <p className="small">Top-holder lists include exchange, bridge and pool wallets.</p>
      </section>

      <section className="card section" aria-label="Chain and token">
        <h3>Chain &amp; token</h3>
        <dl>
          <Row k="Chain" v={res.chain.name} />
          <Row k="Decimals" v={r.token.decimals === undefined ? "unavailable" : String(r.token.decimals)} />
          <Row k="Total supply" v={r.token.totalSupply ?? "unavailable"} />
          {r.token.ownerAddress && <Row k="Owner" v={r.token.ownerAddress} />}
          {r.token.creatorAddress && <Row k="Creator" v={r.token.creatorAddress} />}
        </dl>
        <p className="links">
          <a href={r.links.explorer.url} target="_blank" rel="noopener noreferrer nofollow">{r.links.explorer.label}</a>
          {r.links.dexscreener && <a href={r.links.dexscreener} target="_blank" rel="noopener noreferrer nofollow">DexScreener</a>}
          {r.links.websites.map((w) => <a key={w.url} href={w.url} target="_blank" rel="noopener noreferrer nofollow">{w.label}</a>)}
          {r.links.socials.map((w) => <a key={w.url} href={w.url} target="_blank" rel="noopener noreferrer nofollow">{w.label}</a>)}
        </p>
        <p className="small">Project links come from DexScreener and are not verified by TIMEŒ Rug Check.</p>
      </section>
    </>
  );
}

export default function Page() {
  const [address, setAddress] = useState("");
  const [chain, setChain] = useState<"auto" | ChainKey>("auto");
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<Result | null>(null);
  const [err, setErr] = useState("");
  const kind = detectAddress(address).kind;

  async function onSubmit(e: FormEvent) {
    e.preventDefault(); setBusy(true); setErr(""); setRes(null);
    try {
      const qs = new URLSearchParams({ address: address.trim() });
      if (chain !== "auto" && kind === "evm") qs.set("chain", chain);
      const r = await fetch(`/api/check?${qs}`);
      const j = await r.json();
      if (!r.ok) setErr(j.error ?? "Something went wrong."); else setRes(j);
    } catch { setErr("Network problem. Please try again."); }
    finally { setBusy(false); }
  }

  return (
    <main>
      <h1>TIMEŒ Rug Check</h1>
      <p className="sub">Paste a token address from Solana, Ethereum, BNB Chain, Base, Arbitrum, Polygon, Optimism or Avalanche for a plain-language risk check. The chain is detected automatically. Free and read-only. The verdict comes from fixed checks. An optional explanation can translate it and never changes it.</p>
      <form onSubmit={onSubmit}>
        <input value={address} onChange={(e) => setAddress(e.target.value)} placeholder="Token address (Solana mint or 0x…)" aria-label="Token address"
          autoCapitalize="off" autoCorrect="off" autoComplete="off" spellCheck={false} inputMode="text" />
        <select value={chain} onChange={(e) => setChain(e.target.value as "auto" | ChainKey)} aria-label="Chain" disabled={kind === "solana"}>
          <option value="auto">{kind === "solana" ? "Solana" : "Auto-detect chain"}</option>
          {EVM_CHAINS.map((k) => <option key={k} value={k}>{CHAINS[k].name}</option>)}
        </select>
        <button type="submit" disabled={busy || !address.trim()}>{busy ? "Checking…" : "Check"}</button>
      </form>
      {err && <p className="err" role="alert">{err}</p>}
      {res && (
        <section className="card" aria-live="polite">
          <div className="badges">
            <span className={`badge ${res.verdict}`}>{LABEL[res.verdict]}</span>
            {res.chain && <span className={`chain ${res.chain.key}`}>{res.chain.name}</span>}
          </div>
          {(res.name || res.symbol) && <h2>{res.name}{res.symbol ? ` (${res.symbol})` : ""}</h2>}
          <p className="mint">{res.address ?? res.mint}</p>
          <ul>{res.reasons.map((r) => <li key={r}>{r}</li>)}</ul>
          {res.notes?.length ? <ul className="notes">{res.notes.map((n) => <li key={n} className="small">Note: {n}</li>)}</ul> : null}
          <p className="small">Sources: {res.sources.map((s, i) => (
            <span key={s.name}>{i > 0 && ", "}{s.url && s.ok ? <a href={s.url} target="_blank" rel="noopener noreferrer nofollow">{s.name}</a> : s.name}{s.ok ? "" : " (unavailable)"}</span>
          ))}</p>
          <p className="small">Checked {new Date(res.checkedAt).toLocaleString()}</p>
        </section>
      )}
      {res && <Report res={res} />}
      {res && <ExplainPanel key={`${res.mint}-${res.checkedAt}`} result={res} />}
      <section className="card disclaimer">
        <p><strong>Not financial advice.</strong> TIMEŒ Rug Check is a free, automated tool that reads public blockchain and market data and applies simple heuristics. Results can be wrong, incomplete or out of date, and a &quot;PASS&quot; does not mean a token is safe or a good investment. Always do your own research and never invest more than you can afford to lose. No liability is accepted for decisions made using this tool.</p>
        <p><strong>TIMEŒ Rug Check will never ask you to connect a wallet, share a seed phrase or private key, or send funds.</strong></p>
      </section>
    </main>
  );
}
