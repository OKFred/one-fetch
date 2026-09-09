import { describe, expect, it } from "vitest";

import { hashPassword, verifyPassword } from "./password.js";

describe("Node password hashing", () => {
  it("verifies hashes produced by the original HMAC-then-bcrypt format", async () => {
    const existingHash =
      "$2b$12$abcdefghijklmnopqrstuuSwe9HfDOdVuHv8H32A4iKwNtJwrTPAi";

    await expect(
      verifyPassword(
        "correct horse battery staple",
        "fixture-pepper",
        existingHash,
      ),
    ).resolves.toBe(true);
    await expect(
      verifyPassword("incorrect password", "fixture-pepper", existingHash),
    ).resolves.toBe(false);
  });

  it("keeps bcrypt cost 12 for newly generated hashes", async () => {
    const hash = await hashPassword(
      "correct horse battery staple",
      "fixture-pepper",
    );

    expect(hash).toMatch(/^\$2[ab]\$12\$/u);
    await expect(
      verifyPassword("correct horse battery staple", "fixture-pepper", hash),
    ).resolves.toBe(true);
  });
});
