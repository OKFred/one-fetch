import {
  AlertsResponseV1Schema,
  AuditPageV1Schema,
  ControlFeatureStatusListV1Schema,
  ExecutionTokenListV1Schema,
  SessionListV1Schema,
} from "@one-fetch/protocol";
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
    const bootstrapStatus = await app.request("/api/v1/bootstrap");
    expect(bootstrapStatus.status).toBe(200);
    expect(await bootstrapStatus.json()).toMatchObject({
      initialized: false,
      instanceId: "test-node",
      schemaVersion: 1,
    });
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
        schemaVersion: 1,
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
        schemaVersion: 1,
        policy: {
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
        },
      }),
      headers: {
        Authorization: `Bearer ${session.accessToken}`,
        "Content-Type": "application/json",
        "If-Match": `"${configuration.version}"`,
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
    expect(update.headers.get("ETag")).toBe(`"${updated.version}"`);
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
        auditState: "recorded",
        bodyComplete: true,
        bodySha256: "a".repeat(64),
        finishedAt: new Date().toISOString(),
        outcome: "completed",
        reportId: "report-test",
        requestId: "report-test",
        responseBytes: 4,
        schemaVersion: 1,
        source: "target",
        status: 200,
        timing: {
          phases: [
            {
              durationMs: 2,
              name: "total",
              source: "gateway",
              state: "measured",
            },
          ],
          serverTiming: [],
        },
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
    const deniedAdmin = await app.request("/api/v1/reports/report-test", {
      headers: { Authorization: `Bearer ${session.accessToken}` },
    });
    expect(deniedAdmin.status).toBe(401);
  });

  it("exposes canonical session, feature, token and audit management", async () => {
    const services = await createTestServices();
    cleanups.push(services.cleanup);
    const bootstrapToken = await services.auth.ensureBootstrap();
    const session = await services.auth.bootstrap(
      bootstrapToken!,
      "operator",
      "correct horse battery staple",
    );
    const app = createControlApp(services);
    const headers = { Authorization: `Bearer ${session.accessToken}` };

    const features = await app.request("/api/v1/features", { headers });
    expect(features.status).toBe(200);
    const featurePayload = ControlFeatureStatusListV1Schema.parse(
      await features.json(),
    );
    expect(featurePayload.schemaVersion).toBe(1);
    expect(featurePayload.features).toContainEqual(
      expect.objectContaining({ feature: "totp", state: "unsupported" }),
    );
    const alerts = AlertsResponseV1Schema.parse(
      await (await app.request("/api/v1/alerts", { headers })).json(),
    );
    expect(alerts).toMatchObject({ feature: "alerts", state: "unsupported" });

    const created = await app.request("/api/v1/tokens/execution", {
      body: JSON.stringify(
        testExecutionTokenRequest(["http"], ["https://example.com"]),
      ),
      headers: { ...headers, "Content-Type": "application/json" },
      method: "POST",
    });
    expect(created.status).toBe(201);
    const credential = (await created.json()) as {
      credential: { id: string };
    };
    const listed = await app.request("/api/v1/tokens/execution", { headers });
    const tokenList = ExecutionTokenListV1Schema.parse(await listed.json());
    expect(tokenList.tokens).toContainEqual(
      expect.objectContaining({ id: credential.credential.id }),
    );
    const revoked = await app.request(
      `/api/v1/tokens/execution/${credential.credential.id}`,
      { headers, method: "DELETE" },
    );
    expect(revoked.status).toBe(200);
    expect(await revoked.json()).toMatchObject({
      id: credential.credential.id,
      schemaVersion: 1,
    });

    const sessions = await app.request("/api/v1/auth/sessions", { headers });
    const sessionList = SessionListV1Schema.parse(await sessions.json());
    expect(sessionList.sessions).toContainEqual(
      expect.objectContaining({ current: true }),
    );
    const audit = await app.request("/api/v1/audit?limit=2", { headers });
    expect(audit.status).toBe(200);
    const auditPage = AuditPageV1Schema.parse(await audit.json());
    expect(auditPage.schemaVersion).toBe(1);
    expect(auditPage.events.length).toBeGreaterThan(0);
  });
});
