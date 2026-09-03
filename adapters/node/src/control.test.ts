import { afterEach, describe, expect, it } from "vitest";

import { createControlApp } from "./control.js";
import {
  createTestServices,
  testExecutionTokenRequest,
} from "./test-helpers.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("Node Control API", () => {
  it("publishes OpenAPI and protects configuration routes", async () => {
    const services = await createTestServices();
    cleanups.push(services.cleanup);
    const app = createControlApp(services);

    const health = await app.request("/api/v1/health");
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({
      instanceId: "test-node",
      service: "one-fetch-control",
      status: "ok",
    });
    expect(
      app.getOpenAPI31Document({
        info: { title: "one-fetch Control API", version: "0.1.0" },
        openapi: "3.1.0",
      }),
    ).toMatchObject({ openapi: "3.1.0" });
    const document = await app.request("/api/v1/openapi.json");
    if (document.status !== 200) {
      throw new Error(
        `OpenAPI generation failed: ${document.status} ${await document.text()}`,
      );
    }
    expect(await document.json()).toMatchObject({ openapi: "3.1.0" });

    expect((await app.request("/api/v1/config")).status).toBe(401);
    expect((await app.request("/api/v1/bootstrap")).status).toBe(200);
  });

  it("bootstraps, logs in and atomically updates the empty allowlist", async () => {
    const services = await createTestServices();
    cleanups.push(services.cleanup);
    const app = createControlApp(services);
    const bootstrapToken = await services.auth.ensureBootstrap();
    const bootstrap = await app.request("/api/v1/bootstrap", {
      body: JSON.stringify({
        bootstrapSecret: bootstrapToken,
        password: "correct horse battery staple",
        username: "operator",
      }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    expect(bootstrap.status).toBe(200);
    const session = (await bootstrap.json()) as { accessToken: string };

    const before = await app.request("/api/v1/config", {
      headers: { Authorization: `Bearer ${session.accessToken}` },
    });
    expect(before.status).toBe(200);
    const configuration = (await before.json()) as {
      policy: { revision: number };
      version: string;
    };
    const update = await app.request("/api/v1/config/policy", {
      body: JSON.stringify({
        mode: "allowlist",
        revision: configuration.policy.revision,
        rules: [
          {
            action: "allow",
            enabled: true,
            id: "allow-example",
            match: {
              origins: [
                {
                  caseSensitive: false,
                  operator: "exact",
                  value: "https://example.com",
                },
              ],
            },
            name: "Allow example",
          },
        ],
        schemaVersion: 1,
      }),
      headers: {
        Authorization: `Bearer ${session.accessToken}`,
        "Content-Type": "application/json",
      },
      method: "PUT",
    });
    expect(update.status).toBe(200);
    const updated = (await update.json()) as {
      policy: { revision: number };
      version: string;
    };
    expect(updated.policy.revision).toBe(configuration.policy.revision + 1);
    expect(updated.version).not.toBe(configuration.version);
    expect(
      (await services.audit.list(50)).some((row) =>
        String(row.canonical_json).includes("config.policy.update"),
      ),
    ).toBe(true);
  });

  it("allows only the matching execution token to read a short-lived report", async () => {
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
    const first = await services.auth.createExecutionToken(
      administratorId!,
      testExecutionTokenRequest(["http"], ["https://example.com"]),
    );
    const second = await services.auth.createExecutionToken(
      administratorId!,
      testExecutionTokenRequest(["http"], ["https://example.net"]),
    );
    await services.reports.save(
      {
        bodyComplete: true,
        bodySha256: "a".repeat(64),
        finishedAt: new Date().toISOString(),
        outcome: "completed",
        requestId: "report-test",
        responseBytes: 4,
        timing: { downloadMs: 1, totalMs: 2 },
      },
      first.credential.id,
    );
    const app = createControlApp(services);
    const allowed = await app.request("/api/v1/reports/report-test", {
      headers: { Authorization: `Bearer ${first.token}` },
    });
    expect(allowed.status).toBe(200);
    const denied = await app.request("/api/v1/reports/report-test", {
      headers: { Authorization: `Bearer ${second.token}` },
    });
    expect(denied.status).toBe(404);
  });
});
