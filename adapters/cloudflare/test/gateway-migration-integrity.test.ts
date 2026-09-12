import { verifySignedResponseMetadata } from "@one-fetch/core";
import {
  decodeResponseMetadata,
  encodeRequestMetadata,
  ONE_FETCH_REQUEST_HEADER,
  ONE_FETCH_RESPONSE_HEADER,
  ONE_FETCH_TOKEN_HEADER,
} from "@one-fetch/protocol";
import { createExecutionContext } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";

import { handleGatewayRequest } from "../src/gateway-handler";
import { DEFAULT_CONFIG, type RuntimeConfig } from "../src/types";

const token = "migration-classification-test-token-0123456789";
const gatewayPaths = [
  "/path?query=kept",
  "//other.example/path?x=1&x=2",
  "///[path-only]/items?x=%2f",
];

describe("Cloudflare Gateway migration compatibility boundary", () => {
  it.each(gatewayPaths)("authorizes exact %s", async (path) => {
    const control = {
      authorizeExecutionJson: vi.fn(() =>
        Promise.resolve(
          JSON.stringify({
            allowed: false,
            code: "storage_unavailable",
            message: "The migration state is incompatible",
            auditState: "degraded",
          }),
        ),
      ),
    };
    const targetFetch = vi.spyOn(globalThis, "fetch");
    try {
      const meta = {
        protocolVersion: 1 as const,
        requestId: "migration-classification-1",
        nonce: "0123456789abcdef0123456789abcdef",
        transport: "http" as const,
        targetOrigin: "https://target.example",
        targetHeaders: [],
        fetchOptions: { redirect: "follow" as const, timeoutMs: 60_000 },
        body: { sizeBytes: 0 },
        hop: 0,
      };
      const response = await handleGatewayRequest(
        new Request(`https://gateway.example${path}`, {
          headers: {
            [ONE_FETCH_REQUEST_HEADER]: encodeRequestMetadata(meta),
            [ONE_FETCH_TOKEN_HEADER]: token,
          },
        }),
        {
          CONTROL: control,
          MAX_METADATA_BYTES: "49152",
        } as unknown as CloudflareGatewayEnv,
        createExecutionContext(),
      );

      expect(response.status).toBe(503);
      expect(control.authorizeExecutionJson).toHaveBeenCalledOnce();
      expect(control.authorizeExecutionJson).toHaveBeenCalledWith(
        expect.stringContaining(`"targetUrl":"https://target.example${path}"`),
      );
      expect(targetFetch).not.toHaveBeenCalled();
      const signed = decodeResponseMetadata(
        response.headers.get(ONE_FETCH_RESPONSE_HEADER)!,
      );
      expect(signed).toMatchObject({
        outcome: "relay-error",
        error: {
          code: "storage_unavailable",
          stage: "storage",
          origin: "adapter",
        },
      });
      await expect(
        verifySignedResponseMetadata(signed, {
          token,
          requestId: meta.requestId,
          nonce: meta.nonce,
        }),
      ).resolves.toBe(true);
    } finally {
      targetFetch.mockRestore();
    }
  });

  it("stops before target fetch when decision recording detects drift", async () => {
    const config: RuntimeConfig = structuredClone(DEFAULT_CONFIG);
    config.systemPolicy = {
      schemaVersion: 1,
      mode: "blocklist",
      revision: 1,
      rules: [],
    };
    const control = {
      authorizeExecutionJson: vi.fn(() =>
        Promise.resolve(
          JSON.stringify({
            allowed: true,
            tokenId: "migration-test-token-id",
            config,
            configVersion: "migration-test-config-v1",
            auditState: "recorded",
          }),
        ),
      ),
      recordExecutionDecisionJson: vi.fn(() =>
        Promise.resolve("storage_unavailable" as const),
      ),
      releaseExecutionJson: vi.fn(() => Promise.resolve()),
    };
    const targetFetch = vi.spyOn(globalThis, "fetch");
    try {
      const meta = {
        protocolVersion: 1 as const,
        requestId: "migration-classification-2",
        nonce: "fedcba9876543210fedcba9876543210",
        transport: "http" as const,
        targetOrigin: "https://target.example",
        targetHeaders: [],
        fetchOptions: { redirect: "follow" as const, timeoutMs: 60_000 },
        body: { sizeBytes: 0 },
        hop: 0,
      };
      const response = await handleGatewayRequest(
        new Request("https://gateway.example/path?query=kept", {
          headers: {
            [ONE_FETCH_REQUEST_HEADER]: encodeRequestMetadata(meta),
            [ONE_FETCH_TOKEN_HEADER]: token,
          },
        }),
        {
          CONTROL: control,
          MAX_METADATA_BYTES: "49152",
        } as unknown as CloudflareGatewayEnv,
        createExecutionContext(),
      );

      expect(response.status).toBe(503);
      expect(control.authorizeExecutionJson).toHaveBeenCalledOnce();
      expect(control.recordExecutionDecisionJson).toHaveBeenCalledOnce();
      expect(targetFetch).not.toHaveBeenCalled();
      const signed = decodeResponseMetadata(
        response.headers.get(ONE_FETCH_RESPONSE_HEADER)!,
      );
      expect(signed).toMatchObject({
        outcome: "relay-error",
        error: {
          code: "storage_unavailable",
          stage: "storage",
          origin: "adapter",
        },
      });
      await expect(
        verifySignedResponseMetadata(signed, {
          token,
          requestId: meta.requestId,
          nonce: meta.nonce,
        }),
      ).resolves.toBe(true);
    } finally {
      targetFetch.mockRestore();
    }
  });
});
