import { createServer, type Server } from "node:http";

import {
  encodeRequestMetadata,
  ONE_FETCH_REQUEST_HEADER,
  ONE_FETCH_TOKEN_HEADER,
  type OneFetchRequestMetaV1,
  type PolicySetV1,
} from "@one-fetch/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

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
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("Node Gateway audit degradation", () => {
  it("keeps the target response and durably marks a failed terminal audit", async () => {
    const target = createServer((_request, response) => response.end("ok"));
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
          id: "allow-audit-fixture",
          match: {
            methods: ["GET"],
            origins: [
              { caseSensitive: false, operator: "exact", value: targetOrigin },
            ],
          },
          name: "Allow audit fixture",
        },
      ],
      schemaVersion: 1,
    };
    const update = services.configuration.prepareUpdate(current, policy);
    await services.database.transaction([update.operation]);

    const append = services.audit.append.bind(services.audit);
    vi.spyOn(services.audit, "append").mockImplementation(async (input) => {
      if (input.action === "request.completed")
        throw new Error("injected terminal audit failure");
      return append(input);
    });

    const gateway = createGatewayServer(services);
    const gatewayPort = await listen(gateway);
    cleanups.push(() => closeServer(gateway));
    const metadata: OneFetchRequestMetaV1 = {
      body: { sizeBytes: 0 },
      client: { name: "node-test", version: "0.1.0" },
      fetchOptions: { redirect: "follow", timeoutMs: 60_000 },
      hop: 0,
      nonce: "44444444444444444444444444444444",
      protocolVersion: 1,
      requestId: "terminal-audit-degraded",
      targetHeaders: [],
      targetOrigin,
      transport: "http",
    };

    const response = await fetch(`http://127.0.0.1:${gatewayPort}/fixture`, {
      headers: {
        [ONE_FETCH_REQUEST_HEADER]: encodeRequestMetadata(metadata),
        [ONE_FETCH_TOKEN_HEADER]: issued.token,
      },
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");

    await expect
      .poll(
        async () =>
          (await services.reports.get(metadata.requestId))?.auditState,
      )
      .toBe("degraded");
    const alert = await services.database.get<{
      code: string;
      state: string;
    }>("SELECT code, state FROM operational_alerts WHERE report_id = ?", [
      metadata.requestId,
    ]);
    expect(alert).toEqual({
      code: "terminal_audit_write_failed",
      state: "open",
    });
    const auditJson = JSON.stringify(await services.audit.list(100));
    expect(auditJson).toContain("request.accepted");
    expect(auditJson).not.toContain("request.completed");
  });
});
