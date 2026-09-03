import { classifyFetchOptions } from "@one-fetch/core";
import { describe, expect, it } from "vitest";

import { createCapabilities } from "./capabilities.js";
import type { StoredConfiguration } from "./configuration.js";
import { testConfig } from "./test-helpers.js";

const stored: StoredConfiguration = {
  controlGatewayPairId: "pair-test",
  policy: { mode: "allowlist", revision: 0, rules: [], schemaVersion: 1 },
  updatedAt: "2026-09-04T00:00:00.000Z",
  version: "2026-09-04T00:00:00.000Z:0",
};

describe("Node fetch-option capabilities", () => {
  const capabilities = createCapabilities(testConfig(":memory:"), stored);

  it("rejects proxy routing until approved-IP pinning can be preserved", () => {
    const result = classifyFetchOptions(
      {
        adapter: { proxy: "http://proxy.example:8080" },
        redirect: "follow",
        timeoutMs: 60_000,
      },
      capabilities.fetchOptions,
    );

    expect(result.allowed).toBe(false);
    expect(result.assessments).toContainEqual(
      expect.objectContaining({
        fidelity: "unsupported",
        option: "adapter.proxy",
      }),
    );
  });

  it("declares the TLS inputs implemented by the direct pinned connection", () => {
    const result = classifyFetchOptions(
      {
        adapter: { caPem: "test-ca", rejectUnauthorized: true },
        redirect: "follow",
        timeoutMs: 60_000,
      },
      capabilities.fetchOptions,
    );

    expect(result.allowed).toBe(true);
  });
});
