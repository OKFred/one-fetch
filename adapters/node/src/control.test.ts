import { decodeBase32, generateTotpCode } from "@one-fetch/core";
import {
  AuditPageV1Schema,
  ControlFeatureStatusListV1Schema,
  ExecutionTokenListV1Schema,
  SessionListV1Schema,
  SessionTokenPairV1Schema,
  TotpEnableResponseV1Schema,
  TotpPrepareResponseV1Schema,
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
    const openapi = (await document.json()) as {
      components?: { securitySchemes?: Record<string, unknown> };
      openapi?: string;
      paths?: Record<string, { get?: unknown; post?: unknown }>;
    };
    expect(openapi).toMatchObject({ openapi: "3.1.0" });
    expect(openapi.components?.securitySchemes).toHaveProperty("adminBearer");
    expect(openapi.components?.securitySchemes).toHaveProperty(
      "executionBearer",
    );
    expect(openapi.paths).toHaveProperty("/api/v1/openapi.json");
    expect(openapi.paths?.["/api/v1/config"]?.get).toMatchObject({
      security: [{ adminBearer: [] }],
    });
    expect(openapi.paths?.["/api/v1/reports/{reportId}"]?.get).toMatchObject({
      security: [{ executionBearer: [] }],
    });

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
      expect.objectContaining({ feature: "totp", state: "supported" }),
    );
    const alerts = await app.request("/api/v1/alerts", { headers });
    expect(alerts.status).toBe(501);
    await expect(alerts.json()).resolves.toMatchObject({
      error: { code: "feature_unsupported" },
    });

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

  it("enrolls and requires TOTP through canonical routes", async () => {
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
    const preparedResponse = await app.request("/api/v1/auth/totp/prepare", {
      headers,
      method: "POST",
    });
    expect(preparedResponse.status).toBe(200);
    const prepared = TotpPrepareResponseV1Schema.parse(
      await preparedResponse.json(),
    );
    const code = await generateTotpCode(decodeBase32(prepared.secret));
    const enabledResponse = await app.request("/api/v1/auth/totp/enable", {
      body: JSON.stringify({ code, schemaVersion: 1 }),
      headers: { ...headers, "Content-Type": "application/json" },
      method: "POST",
    });
    expect(enabledResponse.status).toBe(200);
    expect(
      TotpEnableResponseV1Schema.parse(await enabledResponse.json())
        .recoveryCodes,
    ).toHaveLength(10);

    const missing = await app.request("/api/v1/auth/login", {
      body: JSON.stringify({
        password: "correct horse battery staple",
        rememberDevice: false,
        schemaVersion: 1,
        username: "operator",
      }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    expect(missing.status).toBe(428);
    const accepted = await app.request("/api/v1/auth/login", {
      body: JSON.stringify({
        password: "correct horse battery staple",
        rememberDevice: false,
        schemaVersion: 1,
        totpCode: code,
        username: "operator",
      }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    expect(accepted.status).toBe(200);
    expect(SessionTokenPairV1Schema.parse(await accepted.json())).toMatchObject(
      { schemaVersion: 1 },
    );
  });
});
