import { describe, expect, it, vi } from "vitest";
import {
  decodeRequestMetadata,
  ONE_FETCH_REQUEST_HEADER,
  SUPABASE_ORIGINAL_PATH_V1,
  type FetchOptionCapabilityV1,
} from "@one-fetch/protocol";
import { OneFetchGatewayClient } from "../src/gateway.js";

const capabilities: FetchOptionCapabilityV1[] = [
  { option: "redirect", fidelity: "exact" },
  { option: "timeoutMs", fidelity: "exact" },
  { option: "adapter.supabaseAcceptMutations", fidelity: "exact" },
  { option: `adapter.${SUPABASE_ORIGINAL_PATH_V1}`, fidelity: "exact" },
];
const gatewayUrl = "https://project.supabase.co/functions/v1/one-fetch-gateway";
const targetUrl = "https://target.example//v1/echo?a=%2f&a=2";

describe("negotiated Supabase path binding", () => {
  it("keeps the wire URL and binds the original path inside existing V1 metadata", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response(null));
    const options = { adapter: { supabaseAcceptMutations: true } };
    const client = new OneFetchGatewayClient({
      gatewayUrl,
      token: "secret".repeat(8),
      fetch,
      capabilities,
    });
    const result = await client.executeHttp({
      targetUrl,
      method: "GET",
      fetchOptions: options,
    });
    const [url, init] = fetch.mock.calls[0]!;
    expect(url instanceof Request ? url.url : url.toString()).toBe(
      `${gatewayUrl}//v1/echo?a=%2f&a=2`,
    );
    const metadata = decodeRequestMetadata(
      new Headers(init?.headers).get(ONE_FETCH_REQUEST_HEADER)!,
    );
    expect(metadata.protocolVersion).toBe(1);
    expect(metadata.fetchOptions.adapter?.[SUPABASE_ORIGINAL_PATH_V1]).toBe(
      "//v1/echo?a=%2f&a=2",
    );
    expect(metadata.fetchOptions.adapter?.supabaseAcceptMutations).toBe(true);
    expect(options).toEqual({ adapter: { supabaseAcceptMutations: true } });
    expect(result.classification.source).toBe("intermediary");
  });
  it("rejects stale, ambiguous, downgraded and conflicting bindings before fetch", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    for (const declarations of [
      capabilities.slice(0, -1),
      [...capabilities, capabilities[3]!],
      [
        ...capabilities.slice(0, -1),
        { ...capabilities[3]!, fidelity: "unsupported" as const },
      ],
    ]) {
      const client = new OneFetchGatewayClient({
        gatewayUrl,
        token: "secret".repeat(8),
        fetch,
        capabilities: declarations,
      });
      await expect(
        client.executeHttp({ targetUrl, method: "GET" }),
      ).rejects.toThrow(/advertise exact/u);
    }
    const client = new OneFetchGatewayClient({
      gatewayUrl,
      token: "secret".repeat(8),
      fetch,
      capabilities,
    });
    await expect(
      client.executeHttp({
        targetUrl,
        method: "GET",
        fetchOptions: {
          adapter: { [SUPABASE_ORIGINAL_PATH_V1]: "/different" },
        },
      }),
    ).rejects.toThrow(/conflicts/u);
    const unnegotiated = new OneFetchGatewayClient({
      gatewayUrl,
      token: "secret".repeat(8),
      fetch,
    });
    await expect(
      unnegotiated.executeHttp({
        targetUrl,
        method: "GET",
        fetchOptions: {
          adapter: { [SUPABASE_ORIGINAL_PATH_V1]: "//v1/echo?a=%2f&a=2" },
        },
      }),
    ).rejects.toThrow(/advertise exact/u);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("does not inject adapter options into Node or Cloudflare requests", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response(null));
    const client = new OneFetchGatewayClient({
      gatewayUrl: "https://gateway.example",
      token: "secret".repeat(8),
      fetch,
      capabilities: capabilities.slice(0, 2),
    });
    const result = await client.executeHttp({ targetUrl, method: "GET" });
    expect(result.requestMetadata.fetchOptions.adapter).toBeUndefined();
  });
  it("counts the path binding towards the existing metadata byte limit", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const client = new OneFetchGatewayClient({
      gatewayUrl,
      token: "secret".repeat(8),
      fetch,
      capabilities,
    });
    await expect(
      client.executeHttp({
        targetUrl: `https://target.example/${"x".repeat(49_000)}`,
        method: "GET",
      }),
    ).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
});
