import { describe, expect, it } from "vitest";
import { hashSecret, randomToken, secretsMatch } from "../src/crypto";

describe("mailbox secrets", () => {
  it("creates URL-safe random tokens", () => {
    const first = randomToken();
    const second = randomToken();
    expect(first).toMatch(/^[A-Za-z0-9_-]+$/u);
    expect(first).not.toBe(second);
  });

  it("compares a token with its stored hash", async () => {
    const hash = await hashSecret("correct horse battery staple");
    await expect(secretsMatch("correct horse battery staple", hash)).resolves.toBe(true);
    await expect(secretsMatch("wrong", hash)).resolves.toBe(false);
  });
});
