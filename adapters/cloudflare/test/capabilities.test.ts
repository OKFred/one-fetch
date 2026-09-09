import { classifyFetchOptions } from "@one-fetch/core";
import type { FetchOptionsV1 } from "@one-fetch/protocol";
import { describe, expect, it } from "vitest";

import {
  CLOUDFLARE_FETCH_CAPABILITIES,
  createCapabilities,
  type InstanceRecord,
} from "../src/storage";
import { buildUpstreamHeaders } from "../src/gateway/headers";
import { DEFAULT_CONFIG } from "../src/types";

const unsupportedFetchOptions = [
  ["cache", { cache: "no-store" }],
  ["credentials", { credentials: "include" }],
  ["integrity", { integrity: "sha256-preview" }],
  ["keepalive", { keepalive: true }],
  ["mode", { mode: "cors" }],
  ["priority", { priority: "high" }],
  ["referrerPolicy", { referrerPolicy: "no-referrer" }],
  ["duplex", { duplex: "half" }],
  ["decompress", { decompress: true }],
] as const satisfies readonly (readonly [string, Partial<FetchOptionsV1>])[];

describe("Cloudflare fetch-option capabilities", () => {
  it("exposes HTTP as the only Preview transport", () => {
    const instance: InstanceRecord = {
      auditDegraded: false,
      config: DEFAULT_CONFIG,
      configRevision: 0,
      configUpdatedAt: "2026-09-04T00:00:00.000Z",
      configVersion: "preview:0",
      gatewayPaused: false,
      instanceId: "cloudflare-preview",
    };

    const transports = createCapabilities(instance, "0.1.0").transports;
    expect(transports.http.state).toBe("stable");
    expect(transports.websocket.state).toBe("unsupported");
    expect(transports.tcp.state).toBe("unsupported");
    expect(transports.tls.state).toBe("unsupported");
  });

  it.each(unsupportedFetchOptions)(
    "rejects the unimplemented %s option instead of silently ignoring it",
    (option, value) => {
      const result = classifyFetchOptions(
        { redirect: "follow", timeoutMs: 60_000, ...value },
        CLOUDFLARE_FETCH_CAPABILITIES,
      );

      expect(result.allowed).toBe(false);
      expect(result.assessments).toContainEqual(
        expect.objectContaining({ fidelity: "unsupported", option }),
      );
    },
  );

  it("advertises only options consumed by the Preview adapter", () => {
    expect(
      CLOUDFLARE_FETCH_CAPABILITIES.filter(
        ({ fidelity }) => fidelity !== "unsupported",
      ).map(({ option, fidelity }) => [option, fidelity]),
    ).toEqual([
      ["redirect", "exact"],
      ["timeoutMs", "exact"],
      ["referrer", "translated"],
      ["adapter.cloudflareAcceptMutations", "exact"],
    ]);
  });

  it("translates the supported referrer option into a target header", () => {
    const referrer = "https://referrer.example/source";
    const result = buildUpstreamHeaders([], referrer);

    expect(result.headers.get("referer")).toBe(referrer);
    expect(result.mutations).toContainEqual(
      expect.objectContaining({
        actor: "adapter",
        name: "Referer",
        operation: "added",
      }),
    );
  });
});
