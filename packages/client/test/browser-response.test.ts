import { describe, expect, it, vi } from "vitest";
import {
  BROWSER_RESPONSE_CAPABILITY,
  createSignedResponseMetadata,
} from "@one-fetch/core";
import {
  decodeRequestMetadata,
  encodeResponseMetadata,
  ONE_FETCH_REQUEST_HEADER,
  ONE_FETCH_RESPONSE_HEADER,
  type FetchOptionCapabilityV1,
  type OneFetchUnsignedResponseMetaV1,
} from "@one-fetch/protocol";
import { OneFetchGatewayClient } from "../src/index.js";

const token = "of_synthetic_browser_envelope_test";
const capabilities: FetchOptionCapabilityV1[] = [
  BROWSER_RESPONSE_CAPABILITY,
  { option: "redirect", fidelity: "exact" },
  { option: "timeoutMs", fidelity: "exact" },
];

function client(
  options: {
    envelope?: boolean;
    outerStatus?: number;
    targetStatus?: number;
    relay?: boolean;
  } = {},
) {
  const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
    const request = new Request(input, init);
    expect(request.redirect).toBe("manual");
    const metadata = decodeRequestMetadata(
      request.headers.get(ONE_FETCH_REQUEST_HEADER)!,
    );
    const status = options.targetStatus ?? 302;
    const common = {
      protocolVersion: 1 as const,
      requestId: metadata.requestId,
      nonce: metadata.nonce,
      ...(options.envelope
        ? { responseMode: "browser-envelope-v1" as const }
        : {}),
      configVersionUsed: "config-1",
      mutations: [],
      audit: { state: "recorded" as const },
      timing: { phases: [], serverTiming: [] },
    };
    const unsigned: OneFetchUnsignedResponseMetaV1 = options.relay
      ? {
          ...common,
          outcome: "relay-error",
          error: {
            code: "target_not_allowed",
            origin: "one-fetch",
            stage: "policy",
            message: "Denied",
            retryable: false,
          },
        }
      : {
          ...common,
          outcome: "target",
          target: {
            kind: "http",
            status,
            statusText: "Fixture",
            headers: [{ name: "Location", value: "/next" }],
            setCookie: ["a=1; Secure", "b=2; Secure"],
            bodyComplete: true,
          },
        };
    return new Response(
      [204, 205, 304].includes(options.outerStatus ?? 200)
        ? null
        : "original bytes",
      {
        status: options.outerStatus ?? 200,
        headers: {
          [ONE_FETCH_RESPONSE_HEADER]: encodeResponseMetadata(
            await createSignedResponseMetadata(unsigned, token),
          ),
        },
      },
    );
  });
  return {
    fetchMock,
    gateway: new OneFetchGatewayClient({
      gatewayUrl: "https://gateway.example",
      token,
      capabilities,
      fetch: fetchMock,
    }),
  };
}

describe("explicit browser response envelope", () => {
  it.each([201, 204, 205, 301, 302, 303, 304, 307, 308, 404, 503])(
    "retains signed target %i through HTTP 200",
    async (targetStatus) => {
      const { gateway } = client({ envelope: true, targetStatus });
      const result = await gateway.executeHttp({
        method: "GET",
        targetUrl: "https://target.example/path?a=1&a=2",
        fetchOptions: { adapter: { browserResponse: "envelope-v1" } },
      });
      expect(result.response.status).toBe(200);
      expect(result.classification).toMatchObject({
        source: "target",
        target: {
          status: targetStatus,
          setCookie: ["a=1; Secure", "b=2; Secure"],
        },
      });
      expect(await result.response.text()).toBe("original bytes");
    },
  );

  it("keeps signed service errors distinct from target errors", async () => {
    const { gateway } = client({ envelope: true, relay: true });
    const result = await gateway.executeHttp({
      method: "GET",
      targetUrl: "https://target.example/",
      fetchOptions: { adapter: { browserResponse: "envelope-v1" } },
    });
    expect(result.classification).toMatchObject({
      source: "relay",
      error: { code: "target_not_allowed" },
    });
    await result.response.text();
  });

  it.each([
    { envelope: false, outerStatus: 200, requested: true },
    { envelope: true, outerStatus: 302, requested: true },
    { envelope: true, outerStatus: 200, requested: false },
    { envelope: false, outerStatus: 200, requested: false },
  ])(
    "rejects transport/mode substitution: %j",
    async ({ requested, ...options }) => {
      const { gateway } = client(options);
      const result = await gateway.executeHttp({
        method: "GET",
        targetUrl: "https://target.example/",
        ...(requested
          ? { fetchOptions: { adapter: { browserResponse: "envelope-v1" } } }
          : {}),
      });
      expect(result.classification).toEqual({
        source: "intermediary",
        reason: "identity-mismatch",
      });
      await result.response.text();
    },
  );

  it("preserves transparent default for non-browser clients", async () => {
    const { gateway } = client({ outerStatus: 302 });
    const result = await gateway.executeHttp({
      method: "GET",
      targetUrl: "https://target.example/",
    });
    expect(result.classification).toMatchObject({
      source: "target",
      target: { status: 302 },
    });
    expect(result.requestMetadata.fetchOptions.adapter).toBeUndefined();
    await result.response.text();
  });

  it.each([
    undefined,
    capabilities.filter(
      (capability) => capability.option !== "adapter.browserResponse",
    ),
  ])("requires advertised support before sending", async (advertised) => {
    const fetchMock = vi.fn<typeof fetch>();
    const gateway = new OneFetchGatewayClient({
      gatewayUrl: "https://gateway.example",
      token,
      fetch: fetchMock,
      ...(advertised ? { capabilities: advertised } : {}),
    });
    await expect(
      gateway.executeHttp({
        method: "GET",
        targetUrl: "https://target.example/",
        fetchOptions: { adapter: { browserResponse: "envelope-v1" } },
      }),
    ).rejects.toThrow(/capabilities|does not support/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
