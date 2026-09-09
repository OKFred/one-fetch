import { createServer, type Server } from "node:http";

import {
  encodeRequestMetadata,
  ONE_FETCH_REQUEST_HEADER,
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

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const startGateway = async (
  targetOrigin: string,
  rules: PolicySetV1["rules"] = [],
) => {
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
    rules,
    schemaVersion: 1,
  });
  await services.database.transaction([update.operation]);
  const gateway = createGatewayServer(services);
  const port = await listen(gateway);
  cleanups.push(() => closeServer(gateway));
  return { port, token: issued.token };
};

const send = (
  port: number,
  token: string,
  metadata: OneFetchRequestMetaV1,
  body: string,
): Promise<Response> =>
  fetch(`http://127.0.0.1:${port}/start`, {
    body,
    headers: {
      [ONE_FETCH_REQUEST_HEADER]: encodeRequestMetadata(metadata),
      [ONE_FETCH_TOKEN_HEADER]: token,
    },
    method: "POST",
  });

describe("Node Gateway Content-Type authority", () => {
  it("forwards metadata-only Content-Type and removes its body semantics after a 303", async () => {
    const observations: Array<{
      body: string;
      contentType?: string;
      method?: string;
      url?: string;
    }> = [];
    const target = createServer((request, response) => {
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of request as AsyncIterable<Uint8Array>) {
          chunks.push(Buffer.from(chunk));
        }
        const contentType = request.headers["content-type"];
        observations.push({
          body: Buffer.concat(chunks).toString("utf8"),
          ...(typeof contentType === "string" ? { contentType } : {}),
          ...(request.method === undefined ? {} : { method: request.method }),
          ...(request.url === undefined ? {} : { url: request.url }),
        });
        if (request.url === "/start") {
          response.statusCode = 303;
          response.setHeader("Location", "/final");
          response.end();
          return;
        }
        response.end("done");
      })();
    });
    const targetPort = await listen(target);
    cleanups.push(() => closeServer(target));
    const targetOrigin = `http://127.0.0.1:${targetPort}`;
    const { port, token } = await startGateway(targetOrigin, [
      {
        action: "deny",
        enabled: true,
        id: "deny-stale-redirect-body",
        match: {
          body: {
            contentType: { operator: "exact", value: "application/json" },
            kind: "binary",
            minBytes: 1,
            onUnavailable: "no-match",
          },
          methods: ["GET"],
          path: {
            representation: "raw",
            value: { operator: "exact", value: "/final" },
          },
        },
        name: "Reject stale POST body on redirected GET",
      },
    ]);
    const payload = '{"safe":true}';
    const metadata: OneFetchRequestMetaV1 = {
      body: { contentType: "application/json", sizeBytes: payload.length },
      fetchOptions: { redirect: "follow", timeoutMs: 60_000 },
      hop: 0,
      nonce: "44444444444444444444444444444444",
      protocolVersion: 1,
      requestId: "metadata-content-type-redirect",
      targetHeaders: [],
      targetOrigin,
      transport: "http",
    };

    const result = await send(port, token, metadata, payload);

    if (result.status !== 200) {
      throw new Error(
        `Unexpected Gateway status ${result.status}: ${await result.clone().text()}`,
      );
    }
    expect(result.status).toBe(200);
    expect(await result.text()).toBe("done");
    expect(observations).toEqual([
      {
        body: payload,
        contentType: "application/json",
        method: "POST",
        url: "/start",
      },
      { body: "", method: "GET", url: "/final" },
    ]);
  });

  it.each([
    {
      bodyContentType: "text/plain",
      headers: [{ name: "Content-Type", value: "application/json" }],
      requestId: "conflicting-content-type",
    },
    {
      bodyContentType: "application/json",
      headers: [
        { name: "Content-Type", value: "application/json" },
        { name: "content-type", value: "application/json" },
      ],
      requestId: "duplicate-content-type",
    },
  ])("rejects $requestId before contacting the target", async (fixture) => {
    let connections = 0;
    const target = createServer((_request, response) => {
      connections += 1;
      response.end("unexpected");
    });
    const targetPort = await listen(target);
    cleanups.push(() => closeServer(target));
    const targetOrigin = `http://127.0.0.1:${targetPort}`;
    const { port, token } = await startGateway(targetOrigin);
    const payload = "{}";
    const metadata: OneFetchRequestMetaV1 = {
      body: {
        contentType: fixture.bodyContentType,
        sizeBytes: payload.length,
      },
      fetchOptions: { redirect: "follow", timeoutMs: 60_000 },
      hop: 0,
      nonce:
        fixture.requestId === "conflicting-content-type"
          ? "55555555555555555555555555555555"
          : "66666666666666666666666666666666",
      protocolVersion: 1,
      requestId: fixture.requestId,
      targetHeaders: fixture.headers,
      targetOrigin,
      transport: "http",
    };

    const result = await send(port, token, metadata, payload);

    expect(result.status).toBe(400);
    expect(connections).toBe(0);
  });
});
