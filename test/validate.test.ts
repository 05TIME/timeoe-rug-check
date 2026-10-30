import { describe, it, expect } from "vitest";
import { isValidMint } from "../src/validate";

describe("isValidMint", () => {
  it.each(["DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263", "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", "So11111111111111111111111111111111111111112", "11111111111111111111111111111111"])
    ("accepts %s", (m) => expect(isValidMint(m)).toBe(true));
  it.each(["", "hello", "0xdeadbeef", "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB26O", "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263DezX", 42, null])
    ("rejects %s", (m) => expect(isValidMint(m)).toBe(false));
});
