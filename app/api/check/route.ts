import { NextResponse } from "next/server";
import { isValidMint } from "../../../src/validate";
import { checkMint, NotATokenMintError } from "../../../src/server/check";
import { allow } from "../../../src/server/ratelimit";
import { RATE_LIMIT } from "../../../src/server/config";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || "unknown";
  if (!allow(ip, RATE_LIMIT.max, RATE_LIMIT.windowMs))
    return NextResponse.json({ error: "Too many checks. Please try again in a minute." }, { status: 429 });
  const mint = (new URL(req.url).searchParams.get("mint") ?? "").trim();
  if (!isValidMint(mint))
    return NextResponse.json({ error: "That is not a valid Solana token address." }, { status: 400 });
  try {
    return NextResponse.json(await checkMint(mint), { headers: { "cache-control": "no-store" } });
  } catch (err) {
    if (err instanceof NotATokenMintError)
      return NextResponse.json({ error: err.message }, { status: 400 });
    return NextResponse.json({ error: "Check failed. Please try again shortly." }, { status: 503 });
  }
}
