import { describe, expect, it } from "vitest";

import { buildAuditEvent } from "../src/audit";

describe("Cloudflare audit redaction", () => {
  it("redacts credentials in structured request fields before signing", async () => {
    const event = await buildAuditEvent({
      signingKey: process.env.AUDIT_SIGNING_KEY,
      event: {
        occurredAt: "2026-09-04T00:00:00.000Z",
        category: "execution",
        action: "execution.denied",
        outcome: "denied",
        severity: "warning",
        actor: { type: "execution-token", credentialId: "token-1" },
        correlation: { requestId: "request-1" },
        request: {
          transport: "http",
          method: "GET",
          origin: "https://target.example",
          path: "/reset/token/not-for-the-ledger",
          query: [
            ["access_token", "query-secret"],
            ["include", "profile"],
          ],
          headers: [
            { name: "Authorization", value: "Bearer header-secret" },
            { name: "X-Trace", value: "trace-1" },
          ],
        },
      },
    });

    expect(event.request).toMatchObject({
      path: "/reset/token/[REDACTED]",
      query: [
        ["access_token", "[REDACTED]"],
        ["include", "profile"],
      ],
      headers: [{ name: "X-Trace", value: "trace-1" }],
    });
    expect(JSON.stringify(event)).not.toMatch(
      /query-secret|header-secret|not-for-the-ledger/u,
    );
  });
});
