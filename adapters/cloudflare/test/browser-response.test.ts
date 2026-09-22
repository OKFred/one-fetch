import {
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { classifyOneFetchResponse } from "@one-fetch/core";
import { ONE_FETCH_RESPONSE_HEADER } from "@one-fetch/protocol";
import {
  targetResponse,
  relayErrorResponse,
  type TargetResponseInput,
} from "../src/gateway/response";
import type { CompletionInput } from "../src/types";

const token = "of_synthetic_browser_envelope_secret";
const nonce = "0123456789abcdef0123456789abcdef";
function fixture(response: Response, envelope = true) {
  const records: CompletionInput[] = [];
  const ctx = createExecutionContext();
  const input: TargetResponseInput = {
    response,
    token,
    nonce,
    requestId: "browser-mode",
    reportId: "report-mode",
    fetchOptions: envelope
      ? { adapter: { browserResponse: "envelope-v1" } }
      : {},
    auth: {
      allowed: true,
      tokenId: "token-1",
      configVersion: "config-1",
      auditState: "recorded",
    },
    timing: { phases: [], serverTiming: [] },
    mutations: [],
    maxMetadataBytes: 49_152,
    maxResponseBytes: 20_971_520,
    requestBytes: 0,
    startedAt: performance.now(),
    redirects: 0,
    complete(record) {
      records.push(record);
      return Promise.resolve();
    },
    ctx,
  };
  return { input, records, ctx };
}
async function classify(response: Response) {
  return classifyOneFetchResponse(
    response.headers.get(ONE_FETCH_RESPONSE_HEADER),
    { token, nonce, requestId: "browser-mode" },
  );
}

describe("workerd browser envelope and streaming digest", () => {
  it.each([201, 302, 404, 503])(
    "keeps target %i signed while isolating browser control headers",
    async (status) => {
      const headers = new Headers({
        Location: "https://target.example/next",
        "Content-Type": "text/html",
        "Content-Security-Policy": "sandbox",
      });
      headers.append("Set-Cookie", "a=1; Secure");
      headers.append("Set-Cookie", "b=2; Secure");
      const { input, ctx, records } = fixture(
        new Response("abc", { status, headers }),
      );
      const response = await targetResponse(input);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe(
        "application/octet-stream",
      );
      for (const name of ["location", "set-cookie", "content-security-policy"])
        expect(response.headers.has(name)).toBe(false);
      expect(await classify(response)).toMatchObject({
        source: "target",
        metadata: { responseMode: "browser-envelope-v1" },
        target: { status, setCookie: ["a=1; Secure", "b=2; Secure"] },
      });
      expect(await response.text()).toBe("abc");
      await waitOnExecutionContext(ctx);
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        status,
        bodyComplete: true,
        responseBytes: 3,
        bodySha256:
          "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
      });
    },
  );

  it.each([204, 205, 304])(
    "completes bodyless target %i with the empty body digest",
    async (status) => {
      const { input, ctx, records } = fixture(new Response(null, { status }));
      const response = await targetResponse(input);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("");
      await waitOnExecutionContext(ctx);
      expect(records[0]).toMatchObject({
        status,
        responseBytes: 0,
        bodyComplete: true,
        bodySha256:
          "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      });
    },
  );

  it("does not envelope responses unless explicitly requested", async () => {
    const { input, ctx } = fixture(
      new Response("redirect", { status: 302, headers: { Location: "/next" } }),
      false,
    );
    const response = await targetResponse(input);
    expect(response.status).toBe(302);
    expect(await classify(response)).toMatchObject({
      source: "target",
      target: { status: 302 },
    });
    await response.text();
    await waitOnExecutionContext(ctx);
  });

  it("does not record a complete hash for an oversized stream", async () => {
    const { input, ctx, records } = fixture(new Response("oversize"));
    input.maxResponseBytes = 1;
    const response = await targetResponse(input);
    await expect(response.text()).rejects.toThrow();
    await waitOnExecutionContext(ctx);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      outcome: "partial",
      bodyComplete: false,
      errorCode: "response_too_large",
    });
    expect(records[0]?.bodySha256).toBeUndefined();
  });

  it("signs service errors in the requested mode", async () => {
    const response = await relayErrorResponse({
      fetchOptions: { adapter: { browserResponse: "envelope-v1" } },
      problem: {
        code: "target_not_allowed",
        stage: "policy",
        origin: "one-fetch",
        message: "Denied",
        retryable: false,
      },
      status: 403,
      token,
      nonce,
      requestId: "browser-mode",
      configVersion: "config-1",
      audit: "recorded",
    });
    expect(response.status).toBe(200);
    expect(await classify(response)).toMatchObject({
      source: "relay",
      metadata: { responseMode: "browser-envelope-v1" },
    });
  });

  it.each([20_971_520, 20_971_521])(
    "streams the %i-byte boundary without buffering the body",
    async (size) => {
      let remaining = size;
      const source = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (!remaining) {
            controller.close();
            return;
          }
          const length = Math.min(65_536, remaining);
          remaining -= length;
          controller.enqueue(new Uint8Array(length));
        },
      });
      const { input, ctx, records } = fixture(new Response(source));
      const response = await targetResponse(input);
      const reader = response.body!.getReader();
      let received = 0;
      let failed = false;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          received += value.byteLength;
        }
      } catch {
        failed = true;
      }
      await waitOnExecutionContext(ctx);
      expect(failed).toBe(size > input.maxResponseBytes);
      expect(received).toBe(20_971_520);
      expect(records).toHaveLength(1);
      expect(records[0]?.bodyComplete).toBe(!failed);
      if (failed) expect(records[0]?.bodySha256).toBeUndefined();
      else expect(records[0]?.bodySha256).toMatch(/^[a-f0-9]{64}$/u);
    },
  );

  it("cancels the upstream and never finalizes a partial digest as complete", async () => {
    let cancelled = false;
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(8));
      },
      cancel() {
        cancelled = true;
      },
    });
    const { input, ctx, records } = fixture(new Response(source));
    input.cancellationReason = () => "cancelled";
    const response = await targetResponse(input);
    const reader = response.body!.getReader();
    await reader.read();
    await reader.cancel();
    await waitOnExecutionContext(ctx);
    expect(cancelled).toBe(true);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      outcome: "cancelled",
      bodyComplete: false,
    });
    expect(records[0]?.bodySha256).toBeUndefined();
  });
});
