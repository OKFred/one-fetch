import { describe, expect, it } from "vitest";

import type { UnsignedAuditEventV1 } from "@one-fetch/protocol";

import {
  classifyFetchOptions,
  decodeBase32,
  encodeBase32,
  generateAuditSigningKeyPair,
  generateTotpCode,
  openSecret,
  redactAuditEvent,
  signAuditEvent,
  sealSecret,
  verifyAuditEvent,
} from "../src/index.js";

describe("core utilities", () => {
  it("classifies unsupported and vendor-mutated fetch options", () => {
    const result = classifyFetchOptions(
      { redirect: "manual", timeoutMs: 60_000, keepalive: true },
      [
        { option: "redirect", fidelity: "exact" },
        { option: "timeoutMs", fidelity: "exact" },
        {
          option: "keepalive",
          fidelity: "vendor-mutated",
          detail: "Runtime may ignore it",
        },
      ],
    );
    expect(result).toMatchObject({ allowed: true, requiresConfirmation: true });
  });

  it("implements the RFC 6238 SHA-1 test vector", async () => {
    const secret = new TextEncoder().encode("12345678901234567890");
    await expect(
      generateTotpCode(secret, { digits: 8, timestampMs: 59_000 }),
    ).resolves.toBe("94287082");
  });

  it("round-trips Base32 and authenticated encrypted secrets", async () => {
    const secret = new TextEncoder().encode("12345678901234567890");
    const encoded = encodeBase32(secret);
    expect(encoded).toBe("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
    expect(decodeBase32(encoded)).toEqual(secret);

    const sealed = await sealSecret(secret, "instance-pepper", "totp:admin");
    await expect(
      openSecret(sealed, "instance-pepper", "totp:admin"),
    ).resolves.toEqual(secret);
    await expect(
      openSecret(sealed, "wrong-pepper", "totp:admin"),
    ).rejects.toThrow();
  });

  it("removes forbidden audit headers and redacts likely secrets", async () => {
    const event: UnsignedAuditEventV1 = {
      schemaVersion: 1,
      eventId: "event-1",
      occurredAt: "2026-09-04T00:00:00.000Z",
      recordedAt: "2026-09-04T00:00:00.001Z",
      category: "execution",
      action: "completed",
      outcome: "success",
      severity: "info",
      actor: { type: "execution-token" },
      correlation: { requestId: "request-1" },
      request: {
        transport: "http",
        method: "GET",
        path: "/users/secret",
        query: [["access_token", "not-for-the-log"]],
        headers: [
          { name: "Authorization", value: "Bearer never" },
          { name: "X-Api-Key", value: "value" },
        ],
      },
    };
    const redacted = redactAuditEvent(event);
    expect(redacted.request?.headers).toEqual([
      { name: "X-Api-Key", value: "[REDACTED]" },
    ]);
    expect(redacted.request?.query).toEqual([["access_token", "[REDACTED]"]]);

    const keys = await generateAuditSigningKeyPair();
    const signed = await signAuditEvent(
      redacted,
      keys.privateKey,
      "audit-key-1",
    );
    await expect(verifyAuditEvent(signed, keys.publicKey)).resolves.toBe(true);
  });
});
