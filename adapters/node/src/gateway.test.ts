import { createServer, type IncomingMessage, type Server } from "node:http";

import { classifyOneFetchResponse } from "@one-fetch/core";
import {
  encodeRequestMetadata,
  ONE_FETCH_REQUEST_HEADER,
  ONE_FETCH_RESPONSE_HEADER,
  ONE_FETCH_TOKEN_HEADER,
  type OneFetchRequestMetaV1,
  type PolicySetV1,
} from "@one-fetch/protocol";
import { afterEach, describe, expect, it } from "vitest";

import { createGatewayServer } from "./gateway.js";
import {
  createTestServices,
  testExecutionTokenRequest,
} from "./test-helpers.js";

const closeServer = (server: Server): Promise<void> =>
  new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );

const listen = async (server: Server): Promise<number> => {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Expected TCP server address");
  return address.port;
};

const requestHeader = (
  request: IncomingMessage,
  name: string,
): string | undefined => {
  const index = request.rawHeaders.findIndex(
    (entry) => entry.toLowerCase() === name.toLowerCase(),
  );
  return index < 0 ? undefined : request.rawHeaders[index + 1];
};

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("Node transparent Gateway", () => {
  it("preserves path, query, body, explicit headers, Set-Cookie and Server-Timing", async () => {
    let targetObservation:
      | { body: string; dnt?: string; origin?: string; url?: string }
      | undefined;
    const target = createServer((request, response) => {
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of request as AsyncIterable<Uint8Array>) {
          chunks.push(Buffer.from(chunk));
        }
        const dnt = requestHeader(request, "dnt");
        const origin = requestHeader(request, "origin");
        targetObservation = {
          body: Buffer.concat(chunks).toString("utf8"),
          ...(dnt ? { dnt } : {}),
          ...(origin ? { origin } : {}),
          ...(request.url ? { url: request.url } : {}),
        };
        response.statusCode = 201;
        response.setHeader("Content-Type", "application/json");
        response.setHeader("Set-Cookie", ["a=1; Path=/", "b=2; Path=/"]);
        response.setHeader(
          "Server-Timing",
          'db;dur=12.5;desc="query", app;dur=3',
        );
        response.end('{"accepted":true}');
      })();
    });
    const targetPort = await listen(target);
    cleanups.push(() => closeServer(target));
    const targetOrigin = `http://127.0.0.1:${targetPort}`;

    const services = await createTestServices();
    cleanups.push(services.cleanup);
    const bootstrapToken = await services.auth.ensureBootstrap();
    const session = await services.auth.bootstrap(
      bootstrapToken!,
      "operator",
      "correct horse battery staple",
    );
    const administratorId = await services.auth.authenticateAdmin(
      session.accessToken,
    );
    const issued = await services.auth.createExecutionToken(
      administratorId!,
      testExecutionTokenRequest(["http"], [targetOrigin]),
    );
    const current = await services.configuration.get();
    const policy: PolicySetV1 = {
      mode: "allowlist",
      revision: current.policy.revision,
      rules: [
        {
          action: "allow",
          enabled: true,
          id: "allow-fixture",
          match: {
            methods: ["POST"],
            origins: [
              { caseSensitive: false, operator: "exact", value: targetOrigin },
            ],
            path: {
              representation: "raw",
              value: { operator: "exact", value: "/v1/items" },
            },
            query: [
              {
                name: { operator: "exact", value: "tag" },
                presence: "present",
                value: { operator: "exact", value: "b" },
              },
            ],
          },
          name: "Allow local fixture",
        },
      ],
      schemaVersion: 1,
    };
    const update = services.configuration.prepareUpdate(current, policy);
    await services.database.transaction([update.operation]);

    const gateway = createGatewayServer(services);
    const gatewayPort = await listen(gateway);
    cleanups.push(() => closeServer(gateway));
    const payload = '{"hello":"world"}';
    const metadata: OneFetchRequestMetaV1 = {
      body: {
        contentType: "application/json",
        sizeBytes: Buffer.byteLength(payload),
      },
      client: { name: "node-test", version: "0.1.0" },
      fetchOptions: { redirect: "follow", timeoutMs: 60_000 },
      hop: 0,
      nonce: "0123456789abcdef0123456789abcdef",
      protocolVersion: 1,
      requestId: "gateway-roundtrip",
      targetHeaders: [
        { name: "Content-Type", value: "application/json" },
        { name: "DNT", value: "1" },
        { name: "Origin", value: "https://caller.example" },
      ],
      targetOrigin,
      transport: "http",
    };

    const result = await fetch(
      `http://127.0.0.1:${gatewayPort}/v1/items?tag=a&tag=b`,
      {
        body: payload,
        headers: {
          [ONE_FETCH_REQUEST_HEADER]: encodeRequestMetadata(metadata),
          [ONE_FETCH_TOKEN_HEADER]: issued.token,
        },
        method: "POST",
      },
    );
    if (result.status !== 201) {
      throw new Error(
        `Unexpected Gateway status ${result.status}: ${await result.clone().text()}`,
      );
    }
    expect(await result.json()).toEqual({ accepted: true });
    expect(targetObservation).toEqual({
      body: payload,
      dnt: "1",
      origin: "https://caller.example",
      url: "/v1/items?tag=a&tag=b",
    });

    const classified = await classifyOneFetchResponse(
      result.headers.get(ONE_FETCH_RESPONSE_HEADER),
      {
        nonce: metadata.nonce,
        requestId: metadata.requestId,
        token: issued.token,
      },
    );
    expect(classified.source).toBe("target");
    if (classified.source !== "target")
      throw new Error("Expected target classification");
    expect(classified.target.kind).toBe("http");
    if (classified.target.kind !== "http")
      throw new Error("Expected HTTP target metadata");
    expect(classified.target.setCookie).toEqual(["a=1; Path=/", "b=2; Path=/"]);
    expect(classified.metadata.timing.serverTiming).toEqual([
      { description: "query", durationMs: 12.5, name: "db" },
      { durationMs: 3, name: "app" },
    ]);
  });

  it("returns a signed relay error while the default allowlist is empty", async () => {
    const services = await createTestServices();
    cleanups.push(services.cleanup);
    const bootstrapToken = await services.auth.ensureBootstrap();
    const session = await services.auth.bootstrap(
      bootstrapToken!,
      "operator",
      "correct horse battery staple",
    );
    const administratorId = await services.auth.authenticateAdmin(
      session.accessToken,
    );
    const issued = await services.auth.createExecutionToken(
      administratorId!,
      testExecutionTokenRequest(["http"], ["https://example.com"]),
    );
    const gateway = createGatewayServer(services);
    const port = await listen(gateway);
    cleanups.push(() => closeServer(gateway));
    const metadata: OneFetchRequestMetaV1 = {
      body: { sizeBytes: 0 },
      fetchOptions: { redirect: "follow", timeoutMs: 60_000 },
      hop: 0,
      nonce: "abcdef0123456789abcdef0123456789",
      protocolVersion: 1,
      requestId: "default-deny",
      targetHeaders: [],
      targetOrigin: "https://example.com",
      transport: "http",
    };
    const result = await fetch(`http://127.0.0.1:${port}/anything`, {
      headers: {
        [ONE_FETCH_REQUEST_HEADER]: encodeRequestMetadata(metadata),
        [ONE_FETCH_TOKEN_HEADER]: issued.token,
      },
    });
    expect(result.status).toBe(403);
    const classified = await classifyOneFetchResponse(
      result.headers.get(ONE_FETCH_RESPONSE_HEADER),
      {
        nonce: metadata.nonce,
        requestId: metadata.requestId,
        token: issued.token,
      },
    );
    expect(classified.source).toBe("relay");
  });

  it("evaluates resolved IP rules before opening the target connection", async () => {
    let connections = 0;
    const target = createServer((_request, response) => {
      connections += 1;
      response.end("unexpected");
    });
    const targetPort = await listen(target);
    cleanups.push(() => closeServer(target));
    const targetOrigin = `http://localhost:${targetPort}`;
    const services = await createTestServices();
    cleanups.push(services.cleanup);
    const bootstrapToken = await services.auth.ensureBootstrap();
    const session = await services.auth.bootstrap(
      bootstrapToken!,
      "operator",
      "correct horse battery staple",
    );
    const administratorId = await services.auth.authenticateAdmin(
      session.accessToken,
    );
    const issued = await services.auth.createExecutionToken(
      administratorId!,
      testExecutionTokenRequest(["http"], [targetOrigin]),
    );
    const current = await services.configuration.get();
    const update = services.configuration.prepareUpdate(current, {
      mode: "blocklist",
      revision: current.policy.revision,
      rules: [
        {
          action: "deny",
          enabled: true,
          id: "deny-loopback",
          match: { resolvedIpCidrs: ["127.0.0.0/8", "::1/128"] },
          name: "Deny loopback after DNS resolution",
        },
      ],
      schemaVersion: 1,
    });
    await services.database.transaction([update.operation]);
    const gateway = createGatewayServer(services);
    const gatewayPort = await listen(gateway);
    cleanups.push(() => closeServer(gateway));
    const metadata: OneFetchRequestMetaV1 = {
      body: { sizeBytes: 0 },
      fetchOptions: { redirect: "follow", timeoutMs: 60_000 },
      hop: 0,
      nonce: "11111111111111111111111111111111",
      protocolVersion: 1,
      requestId: "resolved-ip-deny",
      targetHeaders: [],
      targetOrigin,
      transport: "http",
    };
    const result = await fetch(`http://127.0.0.1:${gatewayPort}/blocked`, {
      headers: {
        [ONE_FETCH_REQUEST_HEADER]: encodeRequestMetadata(metadata),
        [ONE_FETCH_TOKEN_HEADER]: issued.token,
      },
    });
    expect(result.status).toBe(403);
    expect(connections).toBe(0);
  });
});
