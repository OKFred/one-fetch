import { describe, expect, it } from "vitest";

import {
  ONE_FETCH_REQUEST_HEADER,
  ONE_FETCH_RESPONSE_HEADER,
  ONE_FETCH_WEBSOCKET_PROTOCOL,
  createTunnelServerHello,
  decodeRequestMetadata,
  encodeResponseMetadata,
  type OneFetchUnsignedResponseMetaV1,
} from "@one-fetch/protocol";
import { createSignedResponseMetadata } from "@one-fetch/core";

import {
  OneFetchGatewayClient,
  OneFetchControlClient,
  buildGatewayUrl,
  classifyTunnelServerHello,
  prepareTunnelHandshake,
  type GatewayProgress,
} from "../src/index.js";

async function signedHttpHeader(
  encodedRequest: string,
  token: string,
  status = 200,
): Promise<string> {
  const request = decodeRequestMetadata(encodedRequest);
  return encodeResponseMetadata(
    await createSignedResponseMetadata(
      {
        protocolVersion: 1,
        requestId: request.requestId,
        nonce: request.nonce,
        outcome: "target",
        target: {
          kind: "http",
          status,
          statusText: status === 200 ? "OK" : "Fixture",
          headers: [],
          setCookie: [],
          bodyComplete: true,
        },
        timing: { phases: [], serverTiming: [] },
        configVersionUsed: "v1",
        mutations: [],
        audit: { state: "recorded" },
      },
      token,
    ),
  );
}

describe("gateway client", () => {
  it("uses every Gateway path as a target path", () => {
    expect(
      buildGatewayUrl(
        "https://gateway.example",
        "https://target.example/v1/users?a=1&a=2",
      ).href,
    ).toBe("https://gateway.example/v1/users?a=1&a=2");
  });

  it("preserves target metadata and identifies a signed target error response", async () => {
    let captured: Request | undefined;
    const client = new OneFetchGatewayClient({
      gatewayUrl: "https://gateway.example",
      token: "of_test_token_that_is_long_enough",
      fetch: async (input, init) => {
        captured = new Request(input, init);
        const encoded = captured.headers.get(ONE_FETCH_REQUEST_HEADER);
        expect(encoded).not.toBeNull();
        const request = decodeRequestMetadata(encoded!);
        expect(request.fetchOptions.timeoutMs).toBe(60_000);
        const unsigned: OneFetchUnsignedResponseMetaV1 = {
          protocolVersion: 1,
          requestId: request.requestId,
          nonce: request.nonce,
          outcome: "target",
          target: {
            kind: "http",
            status: 503,
            statusText: "Service Unavailable",
            headers: [{ name: "Set-Cookie", value: "a=1; Secure" }],
            setCookie: ["a=1; Secure", "b=2; Secure"],
            bodyComplete: true,
          },
          timing: { phases: [], serverTiming: [] },
          configVersionUsed: "v1",
          mutations: [],
          audit: { state: "recorded" },
        };
        const signed = await createSignedResponseMetadata(
          unsigned,
          "of_test_token_that_is_long_enough",
        );
        return new Response("target failed", {
          status: 503,
          statusText: "Service Unavailable",
          headers: {
            [ONE_FETCH_RESPONSE_HEADER]: encodeResponseMetadata(signed),
          },
        });
      },
    });

    const result = await client.executeHttp({
      targetUrl: "https://target.example/v1/echo?x=1&x=2",
      method: "POST",
      headers: [
        { name: "X-Repeat", value: "one" },
        { name: "X-Repeat", value: "two" },
      ],
      body: "hello",
      bodySizeBytes: 5,
    });
    expect(captured?.url).toBe("https://gateway.example/v1/echo?x=1&x=2");
    expect(result.classification.source).toBe("target");
    if (
      result.classification.source === "target" &&
      result.classification.target.kind === "http"
    ) {
      expect(result.classification.target.setCookie).toHaveLength(2);
    }
  });

  it("does not mistake an unsigned vendor HTML response for the target", async () => {
    const client = new OneFetchGatewayClient({
      gatewayUrl: "https://gateway.example",
      token: "of_test_token_that_is_long_enough",
      fetch: () =>
        Promise.resolve(
          new Response("<html>challenge</html>", { status: 200 }),
        ),
    });
    const result = await client.executeHttp({
      targetUrl: "https://target.example/",
      method: "GET",
    });
    expect(result.classification).toEqual({
      source: "intermediary",
      reason: "missing-metadata",
    });
  });

  it("tracks streamed response bytes and completes only after download", async () => {
    const token = "of_test_token_that_is_long_enough";
    const progress: GatewayProgress[] = [];
    const client = new OneFetchGatewayClient({
      gatewayUrl: "https://gateway.example",
      token,
      fetch: async (input, init) => {
        const request = new Request(input, init);
        const responseMetadata = await signedHttpHeader(
          request.headers.get(ONE_FETCH_REQUEST_HEADER)!,
          token,
        );
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("he"));
            controller.enqueue(new TextEncoder().encode("llo"));
            controller.close();
          },
        });
        return new Response(body, {
          headers: {
            "Content-Length": "5",
            [ONE_FETCH_RESPONSE_HEADER]: responseMetadata,
          },
        });
      },
    });

    const result = await client.executeHttp({
      targetUrl: "https://target.example/stream",
      method: "GET",
      onProgress: (event) => progress.push(event),
    });
    expect(await result.response.text()).toBe("hello");
    expect(
      progress
        .filter(({ phase }) => phase === "downloading")
        .map(({ loadedBytes, totalBytes }) => [loadedBytes, totalBytes]),
    ).toEqual([
      [0, 5],
      [2, 5],
      [5, 5],
    ]);
    expect(progress.at(-1)).toMatchObject({
      phase: "complete",
      loadedBytes: 5,
      totalBytes: 5,
    });
  });

  it("keeps timeout cancellation active while the response body streams", async () => {
    const token = "of_test_token_that_is_long_enough";
    const progress: GatewayProgress[] = [];
    const client = new OneFetchGatewayClient({
      gatewayUrl: "https://gateway.example",
      token,
      fetch: async (input, init) => {
        const request = new Request(input, init);
        return new Response(
          new ReadableStream<Uint8Array>({
            pull: () => new Promise<void>(() => undefined),
          }),
          {
            headers: {
              [ONE_FETCH_RESPONSE_HEADER]: await signedHttpHeader(
                request.headers.get(ONE_FETCH_REQUEST_HEADER)!,
                token,
              ),
            },
          },
        );
      },
    });
    const result = await client.executeHttp({
      targetUrl: "https://target.example/slow",
      method: "GET",
      fetchOptions: { timeoutMs: 20 },
      onProgress: (event) => progress.push(event),
    });

    await expect(result.response.text()).rejects.toMatchObject({
      name: "TimeoutError",
    });
    expect(progress.some(({ phase }) => phase === "cancelling")).toBe(true);
    expect(progress.some(({ phase }) => phase === "complete")).toBe(false);
  });

  it("aborts an active download through the caller signal", async () => {
    const token = "of_test_token_that_is_long_enough";
    const controller = new AbortController();
    const progress: GatewayProgress[] = [];
    const client = new OneFetchGatewayClient({
      gatewayUrl: "https://gateway.example",
      token,
      fetch: async (input, init) => {
        const request = new Request(input, init);
        return new Response(
          new ReadableStream<Uint8Array>({
            pull: () => new Promise<void>(() => undefined),
          }),
          {
            headers: {
              [ONE_FETCH_RESPONSE_HEADER]: await signedHttpHeader(
                request.headers.get(ONE_FETCH_REQUEST_HEADER)!,
                token,
              ),
            },
          },
        );
      },
    });
    const result = await client.executeHttp({
      targetUrl: "https://target.example/slow",
      method: "GET",
      signal: controller.signal,
      onProgress: (event) => progress.push(event),
    });

    controller.abort(new DOMException("Stopped", "AbortError"));
    await expect(result.response.text()).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(progress.some(({ phase }) => phase === "cancelling")).toBe(true);
  });

  it("signals URL userinfo and translates it into the target Authorization list", async () => {
    const token = "of_test_token_that_is_long_enough";
    const client = new OneFetchGatewayClient({
      gatewayUrl: "https://gateway.example",
      token,
      fetch: async (input, init) => {
        const outer = new Request(input, init);
        const metadata = decodeRequestMetadata(
          outer.headers.get(ONE_FETCH_REQUEST_HEADER)!,
        );
        expect(metadata.targetOrigin).toBe("https://target.example");
        expect(metadata.targetUrlTraits).toEqual({ hasUserinfo: true });
        expect(metadata.targetHeaders).toContainEqual({
          name: "Authorization",
          value: "Basic dXNlcjpww6Rzcw==",
        });
        const signed = await createSignedResponseMetadata(
          {
            protocolVersion: 1,
            requestId: metadata.requestId,
            nonce: metadata.nonce,
            outcome: "target",
            target: {
              kind: "http",
              status: 204,
              statusText: "",
              headers: [],
              setCookie: [],
              bodyComplete: true,
            },
            timing: { phases: [], serverTiming: [] },
            configVersionUsed: "v1",
            mutations: [],
            audit: { state: "recorded" },
          },
          token,
        );
        return new Response(null, {
          status: 204,
          headers: {
            [ONE_FETCH_RESPONSE_HEADER]: encodeResponseMetadata(signed),
          },
        });
      },
    });
    await expect(
      client.executeHttp({
        targetUrl: "https://user:p%C3%A4ss@target.example/private",
        method: "GET",
      }),
    ).resolves.toMatchObject({ classification: { source: "target" } });
  });

  it("prepares and verifies a first-frame browser WebSocket handshake", async () => {
    const request = {
      protocolVersion: 1 as const,
      requestId: "ws-1",
      nonce: "0123456789abcdef0123456789abcdef",
      transport: "websocket" as const,
      targetOrigin: "https://target.example",
      targetHeaders: [],
      fetchOptions: { redirect: "manual" as const, timeoutMs: 60_000 },
      body: {},
      hop: 0,
    };
    const prepared = prepareTunnelHandshake({
      gatewayUrl: "https://gateway.example",
      executionToken: "of_test_token_that_is_long_enough",
      request,
      targetPathAndQuery: "/socket?room=one&room=two",
    });
    expect(prepared).toMatchObject({
      url: "wss://gateway.example/socket?room=one&room=two",
      protocols: [ONE_FETCH_WEBSOCKET_PROTOCOL],
    });
    const signed = await createSignedResponseMetadata(
      {
        protocolVersion: 1,
        requestId: request.requestId,
        nonce: request.nonce,
        outcome: "target",
        target: {
          kind: "tunnel",
          transport: "websocket",
          state: "established",
          selectedSubprotocol: "graphql-ws",
        },
        timing: { phases: [], serverTiming: [] },
        configVersionUsed: "v1",
        mutations: [],
        audit: { state: "recorded" },
      },
      "of_test_token_that_is_long_enough",
    );
    const frame = JSON.stringify(createTunnelServerHello(signed));
    await expect(
      classifyTunnelServerHello(frame, {
        executionToken: "of_test_token_that_is_long_enough",
        request,
      }),
    ).resolves.toMatchObject({ source: "target" });
  });
});

describe("control client", () => {
  it("fetches a report by reportId with an execution bearer token", async () => {
    let authorization: string | null = null;
    const client = new OneFetchControlClient({
      controlUrl: "https://control.example",
      accessToken: "admin_access_token_that_must_not_be_used",
      fetch: (input, init) => {
        const request = new Request(input, init);
        authorization = request.headers.get("Authorization");
        expect(request.url).toBe(
          "https://control.example/api/v1/reports/report-1",
        );
        return Promise.resolve(
          Response.json({
            schemaVersion: 1,
            reportId: "report-1",
            requestId: "request-1",
            outcome: "completed",
            source: "target",
            status: 200,
            responseBytes: 2,
            bodyComplete: true,
            timing: { phases: [], serverTiming: [] },
            finishedAt: "2026-09-04T00:00:00.000Z",
            auditState: "recorded",
          }),
        );
      },
    });
    await expect(
      client.getExecutionReport(
        "report-1",
        "of_execution_token_that_is_long_enough",
      ),
    ).resolves.toMatchObject({ reportId: "report-1", source: "target" });
    expect(authorization).toBe("Bearer of_execution_token_that_is_long_enough");
  });
});
