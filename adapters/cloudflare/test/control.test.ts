import { exports as workerExports } from "cloudflare:workers";
import { env, SELF } from "cloudflare:test";
import {
  CreatedExecutionTokenV1Schema,
  ExecutionReportV1Schema,
  SessionTokenPairV1Schema,
} from "@one-fetch/protocol";
import { describe, expect, it } from "vitest";

const bootstrapBody = {
  schemaVersion: 1,
  bootstrapSecret: "test-bootstrap-token-with-enough-entropy",
  username: "admin",
  password: "correct horse battery staple",
};

describe("Cloudflare Control Worker", () => {
  it("initializes with an empty fail-closed allowlist", async () => {
    const response = await SELF.fetch(
      "https://control.example/api/v1/capabilities",
    );
    expect(response.status).toBe(200);
    const body = await response.json<{
      policyMode: string;
      limits: { timeoutMs: number };
      transports: Record<string, { state: string }>;
    }>();
    expect(body.policyMode).toBe("allowlist");
    expect(body.limits.timeoutMs).toBe(60_000);
    expect(body.transports.http?.state).toBe("stable");

    const row = await env.DB.prepare(
      "SELECT config_json FROM instance_state WHERE singleton = 1",
    ).first<{ config_json: string }>();
    const config = JSON.parse(row!.config_json) as {
      systemPolicy: { rules: unknown[] };
    };
    expect(config.systemPolicy.rules).toEqual([]);
  });

  it("bootstraps one admin, logs in, and creates a scoped execution token", async () => {
    const bootstrap = await jsonRequest("/api/v1/bootstrap", bootstrapBody);
    expect(bootstrap.status).toBe(201);
    const duplicate = await jsonRequest("/api/v1/bootstrap", bootstrapBody);
    expect(duplicate.status).toBe(409);

    const login = await jsonRequest("/api/v1/auth/login", {
      schemaVersion: 1,
      username: bootstrapBody.username,
      password: bootstrapBody.password,
      rememberDevice: false,
    });
    expect(login.status).toBe(200);
    const pair = SessionTokenPairV1Schema.parse(await login.json());
    expect(pair.accessToken).toBeTruthy();
    expect(pair.refreshToken).toBeTruthy();

    const created = await SELF.fetch(
      "https://control.example/api/v1/tokens/execution",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${pair.accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
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
        }),
      },
    );
    expect(created.status).toBe(201);
    const token = CreatedExecutionTokenV1Schema.parse(await created.json());
    expect(token.token.length).toBeGreaterThan(32);
    const persisted = await env.DB.prepare(
      "SELECT token_hash FROM execution_tokens WHERE id = ?",
    )
      .bind(token.credential.id)
      .first<{ token_hash: string }>();
    expect(persisted?.token_hash).not.toBe(token.token);

    const audit = await env.DB.prepare(
      "SELECT action FROM audit_events ORDER BY occurred_at",
    ).all<{ action: string }>();
    expect(audit.results.map(({ action }) => action)).toContain(
      "account.bootstrap",
    );
    expect(audit.results.map(({ action }) => action)).toContain("auth.login");
  });

  it("uses ETags to reject stale configuration writes", async () => {
    await jsonRequest("/api/v1/bootstrap", bootstrapBody);
    const login = await jsonRequest("/api/v1/auth/login", {
      schemaVersion: 1,
      username: bootstrapBody.username,
      password: bootstrapBody.password,
      rememberDevice: false,
    });
    const { accessToken } = await login.json<{ accessToken: string }>();
    const current = await SELF.fetch("https://control.example/api/v1/config", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const etag = current.headers.get("etag")!;
    const payload = await current.json<{ config: unknown }>();
    const first = await SELF.fetch("https://control.example/api/v1/config", {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        "If-Match": etag,
      },
      body: JSON.stringify({ config: payload.config }),
    });
    expect(first.status).toBe(200);
    const stale = await SELF.fetch("https://control.example/api/v1/config", {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        "If-Match": etag,
      },
      body: JSON.stringify({ config: payload.config }),
    });
    expect(stale.status).toBe(412);
  });

  it("returns a schema-validated report only to its execution token", async () => {
    const { pair, credential } = await createCredential("report-token");
    const reportId = crypto.randomUUID();
    await workerExports.ControlService.releaseExecutionJson(
      JSON.stringify({
        tokenId: credential.credential.id,
        requestId: "report-request-1",
        reportId,
        outcome: "target",
        status: 204,
        requestBytes: 0,
        responseBytes: 0,
        durationMs: 12,
        timing: {
          phases: [
            {
              name: "total",
              state: "measured",
              source: "gateway",
              durationMs: 12,
            },
          ],
          serverTiming: [],
        },
        bodyComplete: true,
      }),
    );
    const allowed = await SELF.fetch(
      `https://control.example/api/v1/reports/${reportId}`,
      {
        headers: { Authorization: `Bearer ${credential.token}` },
      },
    );
    expect(allowed.status).toBe(200);
    expect(ExecutionReportV1Schema.parse(await allowed.json())).toMatchObject({
      outcome: "completed",
      source: "target",
      status: 204,
    });
    const denied = await SELF.fetch(
      `https://control.example/api/v1/reports/${reportId}`,
      {
        headers: { Authorization: `Bearer ${pair.accessToken}` },
      },
    );
    expect(denied.status).toBe(404);
  });
});

async function createCredential(name: string) {
  await jsonRequest("/api/v1/bootstrap", bootstrapBody);
  const login = await jsonRequest("/api/v1/auth/login", {
    schemaVersion: 1,
    username: bootstrapBody.username,
    password: bootstrapBody.password,
    rememberDevice: false,
  });
  const pair = SessionTokenPairV1Schema.parse(await login.json());
  const created = await SELF.fetch(
    "https://control.example/api/v1/tokens/execution",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${pair.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        schemaVersion: 1,
        name,
        scope: { transports: ["http"], origins: [], ports: [] },
        quota: {
          requestsPerMinute: 60,
          burst: 10,
          concurrentHttp: 4,
          concurrentTunnels: 0,
          bytesPerDay: 1_048_576,
        },
      }),
    },
  );
  return {
    pair,
    credential: CreatedExecutionTokenV1Schema.parse(await created.json()),
  };
}

function jsonRequest(path: string, body: unknown): Promise<Response> {
  return SELF.fetch(`https://control.example${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}
