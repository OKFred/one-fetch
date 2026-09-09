import { describe, expect, it } from "vitest";

import type { RuntimeConfigurationV1 } from "@one-fetch/protocol";

import { OneFetchControlClient, OneFetchControlError } from "../src/index.js";

const configuration: RuntimeConfigurationV1 = {
  schemaVersion: 1,
  instanceId: "instance-1",
  controlGatewayPairId: "pair-1",
  revision: 4,
  version: "20260904T000000.000Z-4-deadbeef",
  updatedAt: "2026-09-04T00:00:00.000Z",
  gatewayPaused: false,
  policy: { schemaVersion: 1, mode: "allowlist", revision: 3, rules: [] },
};

describe("canonical Control client", () => {
  it("preserves a platform Control base path", async () => {
    let captured = "";
    const client = new OneFetchControlClient({
      controlUrl: "https://project.supabase.co/functions/v1/one-fetch-control/",
      fetch: (input, init) => {
        captured = new Request(input, init).url;
        return Promise.resolve(
          Response.json({
            schemaVersion: 1,
            initialized: false,
            instanceId: "instance-1",
          }),
        );
      },
    });
    await client.getBootstrapStatus();
    expect(captured).toBe(
      "https://project.supabase.co/functions/v1/one-fetch-control/api/v1/bootstrap",
    );
    expect(client.controlOrigin).toBe("https://project.supabase.co");
    expect(client.controlBaseUrl).toBe(
      "https://project.supabase.co/functions/v1/one-fetch-control",
    );
  });

  it("updates policy through the canonical route with optimistic concurrency", async () => {
    let captured: Request | undefined;
    const client = new OneFetchControlClient({
      controlUrl: "https://control.example",
      accessToken: "admin_access_token_that_is_long_enough",
      fetch: (input, init) => {
        captured = new Request(input, init);
        return Promise.resolve(Response.json(configuration));
      },
    });
    await expect(
      client.updatePolicy(
        { schemaVersion: 1, policy: configuration.policy },
        configuration.version,
      ),
    ).resolves.toEqual(configuration);
    expect(captured?.url).toBe("https://control.example/api/v1/config/policy");
    expect(captured?.method).toBe("PUT");
    expect(captured?.headers.get("If-Match")).toBe(
      `"${configuration.version}"`,
    );
    expect(captured?.headers.get("Authorization")).toBe(
      "Bearer admin_access_token_that_is_long_enough",
    );
  });

  it("uses the canonical audit cursor and validates its response envelope", async () => {
    let url = "";
    const client = new OneFetchControlClient({
      controlUrl: "https://control.example",
      fetch: (input, init) => {
        url = new Request(input, init).url;
        return Promise.resolve(Response.json({ schemaVersion: 1, events: [] }));
      },
    });
    await expect(
      client.getAuditPage({ cursor: "cursor/one", limit: 50 }),
    ).resolves.toEqual({ schemaVersion: 1, events: [] });
    expect(url).toBe(
      "https://control.example/api/v1/audit?limit=50&cursor=cursor%2Fone",
    );
  });

  it("surfaces a strict nested Control error without consuming the response", async () => {
    const client = new OneFetchControlClient({
      controlUrl: "https://control.example",
      fetch: () =>
        Promise.resolve(
          Response.json(
            {
              error: {
                code: "feature_unsupported",
                message: "Backups are not implemented by this adapter",
                retryable: false,
                correlationId: "request-1",
              },
            },
            { status: 501 },
          ),
        ),
    });
    const error = await client.getBackups().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(OneFetchControlError);
    expect(error).toMatchObject({
      status: 501,
      code: "feature_unsupported",
      retryable: false,
      correlationId: "request-1",
      message: "Backups are not implemented by this adapter",
    });
    if (!(error instanceof OneFetchControlError))
      throw new TypeError("Expected a OneFetchControlError");
    await expect(error.response.json()).resolves.toMatchObject({
      error: { code: "feature_unsupported" },
    });
  });

  it("models unsupported feature endpoints as successful typed states", async () => {
    const client = new OneFetchControlClient({
      controlUrl: "https://control.example",
      fetch: () =>
        Promise.resolve(
          Response.json({
            schemaVersion: 1,
            feature: "alerts",
            state: "unsupported",
            reason: "Not available in Preview",
          }),
        ),
    });
    await expect(client.getAlerts()).resolves.toMatchObject({
      feature: "alerts",
      state: "unsupported",
    });
  });

  it("uses stable routes for session security operations", async () => {
    const paths: string[] = [];
    const client = new OneFetchControlClient({
      controlUrl: "https://control.example",
      fetch: (input, init) => {
        const request = new Request(input, init);
        paths.push(`${request.method} ${new URL(request.url).pathname}`);
        if (request.url.endsWith("/auth/sessions"))
          return Promise.resolve(
            Response.json({ schemaVersion: 1, sessions: [] }),
          );
        return Promise.resolve(
          Response.json({
            schemaVersion: 1,
            secret: "ABCDEFGHIJKLMNOP",
            otpauthUri:
              "otpauth://totp/one-fetch%3Aadmin?secret=ABCDEFGHIJKLMNOP",
          }),
        );
      },
    });
    await client.listSessions();
    await client.prepareTotp();
    expect(paths).toEqual([
      "GET /api/v1/auth/sessions",
      "POST /api/v1/auth/totp/prepare",
    ]);
  });
});
