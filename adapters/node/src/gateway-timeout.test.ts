import { createServer, type Server } from "node:http";

import { classifyOneFetchResponse } from "@one-fetch/core";
import {
  encodeRequestMetadata,
  ONE_FETCH_REQUEST_HEADER,
  ONE_FETCH_RESPONSE_HEADER,
  ONE_FETCH_TOKEN_HEADER,
  type OneFetchRequestMetaV1,
} from "@one-fetch/protocol";
import { afterEach, describe, expect, it } from "vitest";

import { abortedGatewayFailure, failure } from "./gateway-error.js";
import { interruptedResponseOutcome } from "./gateway-stream.js";
import { createGatewayServer } from "./gateway.js";
import {
  createTestServices,
  testExecutionTokenRequest,
} from "./test-helpers.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No address");
  return `http://127.0.0.1:${address.port}`;
}

async function fixture(streaming: boolean) {
  const targetOrigin = await listen(
    createServer((_request, response) => {
      if (streaming) response.write("first chunk");
      // Leave the target open: only the Gateway's own deadline may stop it.
    }),
  );
  const services = await createTestServices();
  cleanups.push(services.cleanup);
  const secret = await services.auth.ensureBootstrap();
  const session = await services.auth.bootstrap(
    secret!,
    "operator",
    "correct horse battery staple",
  );
  const administrator = await services.auth.authenticateAdmin(
    session.accessToken,
  );
  const issued = await services.auth.createExecutionToken(
    administrator!,
    testExecutionTokenRequest(["http"], [targetOrigin]),
  );
  const current = await services.configuration.get();
  const update = services.configuration.prepareUpdate(current, {
    schemaVersion: 1,
    revision: current.policy.revision,
    mode: "blocklist",
    rules: [],
  });
  await services.database.transaction([update.operation]);
  const gatewayUrl = await listen(createGatewayServer(services));
  const metadata: OneFetchRequestMetaV1 = {
    protocolVersion: 1,
    requestId: "server-deadline",
    nonce: "11111111111111111111111111111111",
    transport: "http",
    targetOrigin,
    targetHeaders: [],
    body: { sizeBytes: 0 },
    hop: 0,
    fetchOptions: {
      redirect: "manual",
      // The body-stage test must reach the first chunk before its deadline.
      // Allow real database/audit and connection setup under parallel CI load;
      // this tests timeout classification, not a 100 ms startup guarantee.
      timeoutMs: streaming ? 1_000 : 100,
    },
  };
  const response = await fetch(`${gatewayUrl}/slow`, {
    headers: {
      [ONE_FETCH_REQUEST_HEADER]: encodeRequestMetadata(metadata),
      [ONE_FETCH_TOKEN_HEADER]: issued.token,
    },
    // Do not let the client timeout hide the Gateway's timeout classification.
    signal: AbortSignal.timeout(5000),
  });
  return { response, metadata, services, issued };
}

describe("Node server-side deadlines", () => {
  it("returns signed timeout/504 while the client is still connected", async () => {
    const { response, metadata, issued } = await fixture(false);
    expect(response.status).toBe(504);
    const result = await classifyOneFetchResponse(
      response.headers.get(ONE_FETCH_RESPONSE_HEADER),
      {
        token: issued.token,
        nonce: metadata.nonce,
        requestId: metadata.requestId,
      },
    );
    expect(result.source).toBe("relay");
    if (result.source === "relay") expect(result.error.code).toBe("timeout");
    await response.arrayBuffer();
  });

  it("records body-stage deadlines as timeout, not partial or cancellation", async () => {
    const { response, metadata, services } = await fixture(true);
    expect(response.status).toBe(200);
    await expect(response.arrayBuffer()).rejects.toThrow();
    await expect
      .poll(
        async () => (await services.reports.get(metadata.requestId))?.outcome,
      )
      .toBe("timeout");
    expect((await services.reports.get(metadata.requestId))?.bodyComplete).toBe(
      false,
    );
    await expect
      .poll(async () => JSON.stringify(await services.audit.list(100)))
      .toContain("request.timeout");
  });

  it("keeps the first abort reason when cancellation races with the deadline", () => {
    const cancelled = new AbortController();
    cancelled.abort(new Error("Client disconnected"));
    cancelled.abort(failure("timeout", "timeout", "Request timed out", 504));
    expect(abortedGatewayFailure(cancelled.signal).problem.code).toBe(
      "cancelled",
    );
    expect(interruptedResponseOutcome(true, cancelled.signal)).toBe(
      "cancelled",
    );
    const timedOut = new AbortController();
    timedOut.abort(failure("timeout", "timeout", "Request timed out", 504));
    timedOut.abort(new Error("Client disconnected"));
    expect(interruptedResponseOutcome(true, timedOut.signal)).toBe("timeout");
  });
});
