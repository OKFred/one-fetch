import { env, SELF } from "cloudflare:test";
import {
  AlertsResponseV1Schema,
  AuditPageV1Schema,
  BackupsResponseV1Schema,
  BootstrapStatusV1Schema,
  ControlFeatureStatusListV1Schema,
  CreatedExecutionTokenV1Schema,
  ExecutionTokenListV1Schema,
  ExecutionTokenRevokeResponseV1Schema,
  OneFetchCapabilitiesV1Schema,
  RuntimeConfigurationV1Schema,
} from "@one-fetch/protocol";
import { describe, expect, it } from "vitest";

import { controlApp } from "../src/control-routes";
import {
  authorizedRequest,
  bootstrapAdmin,
  bootstrapBody,
  expectControlError,
  jsonRequest,
} from "./control-fixtures";

describe("Cloudflare canonical Control API", () => {
  it("publishes fail-closed capabilities, bootstrap status, and honest features", async () => {
    const capabilitiesResponse = await SELF.fetch(
      "https://control.example/api/v1/capabilities",
    );
    expect(capabilitiesResponse.status).toBe(200);
    const capabilities = OneFetchCapabilitiesV1Schema.parse(
      await capabilitiesResponse.json(),
    );
    expect(capabilities.policyMode).toBe("allowlist");
    expect(capabilities.limits.timeoutMs).toBe(60_000);
    expect(capabilities.transports.http.state).toBe("stable");

    const bootstrap = BootstrapStatusV1Schema.parse(
      await (
        await SELF.fetch("https://control.example/api/v1/bootstrap")
      ).json(),
    );
    expect(bootstrap).toMatchObject({ initialized: false });
    expect(bootstrap.instanceId).toBe(capabilities.instanceId);

    const features = ControlFeatureStatusListV1Schema.parse(
      await (
        await SELF.fetch("https://control.example/api/v1/features")
      ).json(),
    );
    expect(featureState(features, "totp")).toBe("supported");
    expect(featureState(features, "alerts")).toBe("degraded");
    expect(featureState(features, "backups")).toBe("unsupported");

    expect(
      controlApp.getOpenAPI31Document({
        info: { title: "one-fetch Control API", version: "0.1.0" },
        openapi: "3.1.0",
      }),
    ).toMatchObject({ openapi: "3.1.0" });
    const openapi = await (
      await SELF.fetch("https://control.example/api/v1/openapi.json")
    ).json<{
      openapi: string;
      paths: Record<string, { get?: { security?: unknown[] } }>;
      components: { securitySchemes: Record<string, unknown> };
    }>();
    expect(openapi).toMatchObject({ openapi: "3.1.0" });
    expect(openapi.paths).toHaveProperty("/api/v1/config/gateway-paused");
    expect(openapi.paths).toHaveProperty("/api/v1/auth/sessions/{sessionId}");
    expect(openapi.paths).toHaveProperty("/api/v1/tokens/execution/{tokenId}");
    expect(openapi.paths).toHaveProperty("/api/v1/features/{feature}");
    expect(openapi.paths).toHaveProperty("/api/v1/reports/{reportId}");
    expect(openapi.components.securitySchemes).toHaveProperty("adminBearer");
    expect(openapi.components.securitySchemes).toHaveProperty(
      "executionBearer",
    );
    expect(openapi.paths["/api/v1/reports/{reportId}"]?.get?.security).toEqual([
      { executionBearer: [] },
    ]);
    expect(Object.keys(openapi.paths).sort()).toEqual(
      [
        "/api/v1/alerts",
        "/api/v1/audit",
        "/api/v1/auth/login",
        "/api/v1/auth/logout",
        "/api/v1/auth/password",
        "/api/v1/auth/refresh",
        "/api/v1/auth/sessions",
        "/api/v1/auth/sessions/{sessionId}",
        "/api/v1/auth/totp/enable",
        "/api/v1/auth/totp/prepare",
        "/api/v1/backups",
        "/api/v1/bootstrap",
        "/api/v1/capabilities",
        "/api/v1/config",
        "/api/v1/config/gateway-paused",
        "/api/v1/config/policy",
        "/api/v1/features",
        "/api/v1/features/{feature}",
        "/api/v1/health",
        "/api/v1/openapi.json",
        "/api/v1/reports/{reportId}",
        "/api/v1/tokens/execution",
        "/api/v1/tokens/execution/{tokenId}",
      ].sort(),
    );

    const row = await env.DB.prepare(
      "SELECT config_json FROM instance_state WHERE singleton = 1",
    ).first<{ config_json: string }>();
    const config = JSON.parse(row!.config_json) as {
      systemPolicy: { rules: unknown[] };
    };
    expect(config.systemPolicy.rules).toEqual([]);
  });

  it("returns canonical auth errors and token lifecycle records", async () => {
    const pair = await bootstrapAdmin();
    await expectControlError(
      await jsonRequest("/api/v1/bootstrap", bootstrapBody),
      409,
      "already_initialized",
    );
    await expectControlError(
      await SELF.fetch("https://control.example/api/v1/config"),
      401,
      "unauthorized",
    );

    const createdResponse = await authorizedRequest(
      pair.accessToken,
      "/api/v1/tokens/execution",
      {
        method: "POST",
        body: {
          schemaVersion: 1,
          name: "test-token",
          scope: {
            transports: ["http"],
            origins: ["https://example.com"],
            ports: [443],
          },
          quota: {
            requestsPerMinute: 60,
            burst: 10,
            concurrentHttp: 4,
            concurrentTunnels: 0,
            bytesPerDay: 1_048_576,
          },
        },
      },
    );
    const created = CreatedExecutionTokenV1Schema.parse(
      await createdResponse.json(),
    );
    const stored = await env.DB.prepare(
      "SELECT token_hash FROM execution_tokens WHERE id = ?",
    )
      .bind(created.credential.id)
      .first<{ token_hash: string }>();
    expect(stored?.token_hash).not.toBe(created.token);

    const listed = ExecutionTokenListV1Schema.parse(
      await (
        await authorizedRequest(pair.accessToken, "/api/v1/tokens/execution")
      ).json(),
    );
    expect(listed.tokens).toHaveLength(1);
    expect(listed.tokens[0]?.id).toBe(created.credential.id);

    const revoked = ExecutionTokenRevokeResponseV1Schema.parse(
      await (
        await authorizedRequest(
          pair.accessToken,
          `/api/v1/tokens/execution/${created.credential.id}`,
          { method: "DELETE" },
        )
      ).json(),
    );
    expect(revoked.id).toBe(created.credential.id);
  });

  it("updates policy and pause state with strong ETag preconditions", async () => {
    const pair = await bootstrapAdmin();
    const currentResponse = await authorizedRequest(
      pair.accessToken,
      "/api/v1/config",
    );
    const current = RuntimeConfigurationV1Schema.parse(
      await currentResponse.json(),
    );
    const etag = currentResponse.headers.get("etag")!;

    await expectControlError(
      await authorizedRequest(pair.accessToken, "/api/v1/config/policy", {
        method: "PUT",
        body: { schemaVersion: 1, policy: current.policy },
      }),
      428,
      "precondition_required",
    );

    const updatedResponse = await authorizedRequest(
      pair.accessToken,
      "/api/v1/config/policy",
      {
        method: "PUT",
        headers: { "If-Match": etag },
        body: {
          schemaVersion: 1,
          policy: { ...current.policy, revision: current.policy.revision + 1 },
        },
      },
    );
    const updated = RuntimeConfigurationV1Schema.parse(
      await updatedResponse.json(),
    );
    expect(updated.revision).toBe(current.revision + 1);
    expect(updated.version).not.toBe(current.version);

    await expectControlError(
      await authorizedRequest(pair.accessToken, "/api/v1/config/policy", {
        method: "PUT",
        headers: { "If-Match": etag },
        body: { schemaVersion: 1, policy: updated.policy },
      }),
      412,
      "config_conflict",
    );

    const pausedResponse = await authorizedRequest(
      pair.accessToken,
      "/api/v1/config/gateway-paused",
      {
        method: "PUT",
        headers: { "If-Match": updatedResponse.headers.get("etag")! },
        body: { schemaVersion: 1, paused: true },
      },
    );
    expect(
      RuntimeConfigurationV1Schema.parse(await pausedResponse.json())
        .gatewayPaused,
    ).toBe(true);

    const alerts = AlertsResponseV1Schema.parse(
      await (
        await authorizedRequest(pair.accessToken, "/api/v1/alerts")
      ).json(),
    );
    expect(alerts.state).toBe("degraded");
    if (alerts.state !== "unsupported") {
      expect(alerts.alerts.some(({ type }) => type === "gateway_paused")).toBe(
        true,
      );
    }
    const backups = BackupsResponseV1Schema.parse(
      await (
        await authorizedRequest(pair.accessToken, "/api/v1/backups")
      ).json(),
    );
    expect(backups.state).toBe("unsupported");
  });

  it("commits only one success audit for concurrent configuration CAS", async () => {
    const pair = await bootstrapAdmin();
    const currentResponse = await authorizedRequest(
      pair.accessToken,
      "/api/v1/config",
    );
    const current = RuntimeConfigurationV1Schema.parse(
      await currentResponse.json(),
    );
    const etag = currentResponse.headers.get("etag")!;
    const responses = await Promise.all(
      [1, 2].map((increment) =>
        authorizedRequest(pair.accessToken, "/api/v1/config/policy", {
          method: "PUT",
          headers: { "If-Match": etag },
          body: {
            schemaVersion: 1,
            policy: {
              ...current.policy,
              revision: current.policy.revision + increment,
            },
          },
        }),
      ),
    );
    expect(responses.map(({ status }) => status).sort()).toEqual([200, 412]);
    const audit = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM audit_events WHERE action = 'config.policy.update' AND outcome = 'success'",
    ).first<{ count: number }>();
    expect(audit?.count).toBe(1);
  });

  it("paginates canonical audit records", async () => {
    const pair = await bootstrapAdmin();
    await authorizedRequest(pair.accessToken, "/api/v1/tokens/execution", {
      method: "POST",
      body: {
        schemaVersion: 1,
        name: "audit-token",
        scope: { transports: ["http"], origins: [], ports: [] },
        quota: {
          requestsPerMinute: 60,
          burst: 10,
          concurrentHttp: 4,
          concurrentTunnels: 0,
          bytesPerDay: 1_048_576,
        },
      },
    });
    const first = AuditPageV1Schema.parse(
      await (
        await authorizedRequest(pair.accessToken, "/api/v1/audit?limit=1")
      ).json(),
    );
    expect(first.events).toHaveLength(1);
    expect(first.nextCursor).toBeTruthy();
    const second = AuditPageV1Schema.parse(
      await (
        await authorizedRequest(
          pair.accessToken,
          `/api/v1/audit?limit=1&cursor=${encodeURIComponent(first.nextCursor!)}`,
        )
      ).json(),
    );
    expect(second.events).toHaveLength(1);
    expect(second.events[0]?.eventId).not.toBe(first.events[0]?.eventId);
  });
});

function featureState(
  status: ReturnType<typeof ControlFeatureStatusListV1Schema.parse>,
  feature: string,
): string | undefined {
  return status.features.find((entry) => entry.feature === feature)?.state;
}
