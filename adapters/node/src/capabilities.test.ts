import { classifyFetchOptions } from "@one-fetch/core";
import type { FetchOptionsV1 } from "@one-fetch/protocol";
import { describe, expect, it } from "vitest";

import { createCapabilities } from "./capabilities.js";
import type { StoredConfiguration } from "./configuration.js";
import { testConfig } from "./test-helpers.js";

const stored: StoredConfiguration = {
  controlGatewayPairId: "pair-test",
  gatewayPaused: false,
  instanceId: "test-node",
  policy: { mode: "allowlist", revision: 0, rules: [], schemaVersion: 1 },
  revision: 0,
  schemaVersion: 1,
  updatedAt: "2026-09-04T00:00:00.000Z",
  version: "2026-09-04T00:00:00.000Z:0",
};

const unsupportedFetchOptions = [
  ["cache", { cache: "no-store" }],
  ["credentials", { credentials: "include" }],
  ["integrity", { integrity: "sha256-preview" }],
  ["keepalive", { keepalive: true }],
  ["mode", { mode: "cors" }],
  ["priority", { priority: "high" }],
  ["referrer", { referrer: "https://referrer.example/" }],
  ["referrerPolicy", { referrerPolicy: "no-referrer" }],
  ["duplex", { duplex: "half" }],
  ["decompress", { decompress: true }],
] as const satisfies readonly (readonly [string, Partial<FetchOptionsV1>])[];

describe("Node fetch-option capabilities", () => {
  const capabilities = createCapabilities(testConfig(":memory:"), stored);

  it("exposes HTTP as the only Preview transport", () => {
    expect(capabilities.transports.http.state).toBe("stable");
    expect(capabilities.transports.websocket.state).toBe("unsupported");
    expect(capabilities.transports.tcp.state).toBe("unsupported");
    expect(capabilities.transports.tls.state).toBe("unsupported");
  });

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

  it.each(unsupportedFetchOptions)(
    "rejects the unimplemented %s option instead of silently ignoring it",
    (option, value) => {
      const result = classifyFetchOptions(
        {
          redirect: "follow",
          timeoutMs: 60_000,
          ...value,
        },
        capabilities.fetchOptions,
      );

      expect(result.allowed).toBe(false);
      expect(result.assessments).toContainEqual(
        expect.objectContaining({ fidelity: "unsupported", option }),
      );
    },
  );

  it("advertises only the Preview options wired into the Node upstream", () => {
    expect(
      capabilities.fetchOptions
        .filter(({ fidelity }) => fidelity !== "unsupported")
        .map(({ option, fidelity }) => [option, fidelity]),
    ).toEqual([
      ["redirect", "translated"],
      ["timeoutMs", "exact"],
      ["adapter.caPem", "exact"],
      ["adapter.clientCertificatePem", "exact"],
      ["adapter.clientPrivateKeyPem", "exact"],
      ["adapter.rejectUnauthorized", "exact"],
    ]);
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
