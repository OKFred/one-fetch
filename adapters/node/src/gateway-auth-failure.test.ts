import { createServer, type Server } from "node:http";

import { classifyOneFetchResponse } from "@one-fetch/core";
import {
  encodeRequestMetadata,
  ONE_FETCH_REQUEST_HEADER,
  ONE_FETCH_RESPONSE_HEADER,
  ONE_FETCH_TOKEN_HEADER,
  type OneFetchRequestMetaV1,
} from "@one-fetch/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createGatewayServer } from "./gateway.js";
import {
  createTestServices,
  testExecutionTokenRequest,
} from "./test-helpers.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const listen = async (server: Server): Promise<string> => {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  cleanups.push(
    () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  );
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Expected TCP listener");
  return `http://127.0.0.1:${address.port}`;
};

const setup = async () => {
  let connections = 0;
  const target = createServer((_request, response) =>
    response.end("unexpected"),
  );
  target.on("connection", () => {
    connections += 1;
  });
  const targetOrigin = await listen(target);
  const services = await createTestServices();
  cleanups.push(services.cleanup);
  const configuration = await services.configuration.get();
  const update = services.configuration.prepareUpdate(configuration, {
    ...configuration.policy,
    mode: "blocklist",
    rules: [],
  });
  await services.database.transaction([update.operation]);
  const gateway = await listen(createGatewayServer(services));
  const metadata: OneFetchRequestMetaV1 = {
    body: { sizeBytes: 0 },
    fetchOptions: { redirect: "follow", timeoutMs: 60_000 },
    hop: 0,
    nonce: "0123456789abcdef0123456789abcdef",
    protocolVersion: 1,
    requestId: "auth-failure",
    targetHeaders: [],
    targetOrigin,
    transport: "http",
  };
  const send = (token?: string, encoded = encodeRequestMetadata(metadata)) =>
    fetch(gateway + "/status/200", {
      headers: {
        [ONE_FETCH_REQUEST_HEADER]: encoded,
        ...(token ? { [ONE_FETCH_TOKEN_HEADER]: token } : {}),
      },
    });
  const classify = (response: Response, token: string) =>
    classifyOneFetchResponse(response.headers.get(ONE_FETCH_RESPONSE_HEADER), {
      nonce: metadata.nonce,
      requestId: metadata.requestId,
      token,
    });
  return {
    services,
    send,
    classify,
    metadata,
    targetOrigin,
    configuration: update.configuration,
    connections: () => connections,
  };
};

describe("Node Gateway early error provenance", () => {
  it.each(["unknown", "revoked"])(
    "signs %s token denial without connecting upstream",
    async (kind) => {
      const fixture = await setup();
      let token = "synthetic-invalid-execution-token";
      if (kind === "revoked") {
        const bootstrap = await fixture.services.auth.ensureBootstrap();
        const session = await fixture.services.auth.bootstrap(
          bootstrap!,
          "operator",
          "correct horse battery staple",
        );
        const admin = await fixture.services.auth.authenticateAdmin(
          session.accessToken,
        );
        const issued = await fixture.services.auth.createExecutionToken(
          admin!,
          testExecutionTokenRequest(["http"], [fixture.targetOrigin]),
        );
        token = issued.token;
        await fixture.services.auth.revokeExecutionToken(
          admin!,
          issued.credential.id,
        );
      }
      const response = await fixture.send(token);
      expect(response.status).toBe(401);
      expect(response.headers.get("cache-control")).toBe("no-store");
      const classification = await fixture.classify(response, token);
      expect(classification.source).toBe("relay");
      if (classification.source === "relay") {
        expect(classification.error.code).toBe("unauthorized");
        expect(classification.metadata.configVersionUsed).toBe(
          fixture.configuration.version,
        );
      }
      expect(await fixture.classify(response, token + "-wrong")).toMatchObject({
        source: "intermediary",
      });
      expect(await response.text()).not.toContain(token);
      expect(fixture.connections()).toBe(0);
    },
  );

  it.each(["missing-token", "invalid-metadata"])(
    "does not fabricate response binding for %s",
    async (kind) => {
      const fixture = await setup();
      const configuration = vi.spyOn(fixture.services.configuration, "get");
      const authentication = vi.spyOn(
        fixture.services.auth,
        "authenticateExecution",
      );
      const response =
        kind === "missing-token"
          ? await fixture.send()
          : await fixture.send("synthetic-token", "invalid");
      expect(response.headers.get(ONE_FETCH_RESPONSE_HEADER)).toBeNull();
      expect(response.status).toBe(kind === "missing-token" ? 401 : 400);
      await response.arrayBuffer();
      expect(configuration).not.toHaveBeenCalled();
      expect(authentication).not.toHaveBeenCalled();
      expect(fixture.connections()).toBe(0);
    },
  );

  it("fails closed with signed sanitized errors when credential storage fails", async () => {
    const fixture = await setup();
    vi.spyOn(fixture.services.auth, "authenticateExecution").mockRejectedValue(
      new Error("private-database-canary"),
    );
    const response = await fixture.send("synthetic-token");
    expect(response.status).toBe(502);
    expect(await fixture.classify(response, "synthetic-token")).toMatchObject({
      source: "relay",
      error: { code: "upstream_network" },
    });
    expect(await response.text()).not.toContain("private-database-canary");
    expect(fixture.connections()).toBe(0);
  });

  it("does not invent a configuration version when configuration storage fails", async () => {
    const fixture = await setup();
    vi.spyOn(fixture.services.configuration, "get").mockRejectedValue(
      new Error("private-database-canary"),
    );
    const authentication = vi.spyOn(
      fixture.services.auth,
      "authenticateExecution",
    );
    const response = await fixture.send("synthetic-token");
    expect(response.status).toBe(502);
    expect(response.headers.get(ONE_FETCH_RESPONSE_HEADER)).toBeNull();
    expect(await response.text()).not.toContain("private-database-canary");
    expect(authentication).not.toHaveBeenCalled();
    expect(fixture.connections()).toBe(0);
  });
});
