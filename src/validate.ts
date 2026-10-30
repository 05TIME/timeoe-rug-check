const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** Decode base58; returns null on invalid characters. */
export function base58Decode(s: string): Uint8Array | null {
  let n = 0n;
  for (const c of s) {
    const i = ALPHABET.indexOf(c);
    if (i < 0) return null;
    n = n * 58n + BigInt(i);
  }
  const bytes: number[] = [];
  while (n > 0n) { bytes.unshift(Number(n & 0xffn)); n >>= 8n; }
  for (const c of s) { if (c === "1") bytes.unshift(0); else break; }
  return Uint8Array.from(bytes);
}

/** A Solana address is base58 encoding exactly 32 bytes. */
export function isValidMint(input: unknown): input is string {
  if (typeof input !== "string") return false;
  const s = input.trim();
  if (s.length < 32 || s.length > 44) return false;
  const b = base58Decode(s);
  return b !== null && b.length === 32;
}
