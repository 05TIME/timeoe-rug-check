import { NextResponse } from "next/server";
import { detectAddress, isChainKey, CHAINS } from "../../../src/chains";
import { checkToken, NotATokenMintError, NotATokenContractError } from "../../../src/server/check";
import { allow } from "../../../src/server/ratelimit";
import { RATE_LIMIT } from "../../../src/server/config";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/** GET /api/check?address=<Solana mint or 0x contract>&chain=<optional chain key>. `mint=` is still accepted. */
export async function GET(req: Request) {
  const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || "unknown";
  if (!allow(ip, RATE_LIMIT.max, RATE_LIMIT.windowMs))
    return NextResponse.json({ error: "Too many checks. Please try again in a minute." }, { status: 429 });
  const params = new URL(req.url).searchParams;
  const raw = (params.get("address") ?? params.get("mint") ?? "").trim();
  const chainParam = (params.get("chain") ?? "").trim().toLowerCase();
  const kind = detectAddress(raw);
  if (kind.kind === "invalid")
    return NextResponse.json({ error: "That is not a valid token address. Paste a Solana mint address or a 0x… token contract address." }, { status: 400 });
  if (chainParam && chainParam !== "auto" && !isChainKey(chainParam))
    return NextResponse.json({ error: "Unknown chain." }, { status: 400 });
  const chain = chainParam && chainParam !== "auto" && isChainKey(chainParam) ? chainParam : undefined;
  if (chain && (CHAINS[chain].family === "solana") !== (kind.kind === "solana"))
    return NextResponse.json({ error: `That address is not a ${CHAINS[chain].name} address.` }, { status: 400 });
  try {
    return NextResponse.json(await checkToken({ address: kind.address, chain }), { headers: { "cache-control": "no-store" } });
  } catch (err) {
    if (err instanceof NotATokenMintError || err instanceof NotATokenContractError)
      return NextResponse.json({ error: err.message }, { status: 400 });
    return NextResponse.json({ error: "Check failed. Please try again shortly." }, { status: 503 });
  }
}
