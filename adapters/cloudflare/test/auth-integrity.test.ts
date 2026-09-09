import { env } from "cloudflare:test";
import {
  SessionTokenPairV1Schema,
  TotpPrepareResponseV1Schema,
} from "@one-fetch/protocol";
import { describe, expect, it } from "vitest";

import { AuthRepository } from "../src/auth-repository";
import { generateTotp } from "../src/totp";
import {
  authorizedRequest,
  bootstrapAdmin,
  bootstrapBody,
  createCredential,
  expectControlError,
  jsonRequest,
  loginAdmin,
} from "./control-fixtures";

describe("Cloudflare authentication integrity", () => {
  it("maps concurrent administrator bootstrap to one success and one conflict", async () => {
    const responses = await Promise.all([
      jsonRequest("/api/v1/bootstrap", bootstrapBody),
      jsonRequest("/api/v1/bootstrap", bootstrapBody),
    ]);
    expect(responses.map(({ status }) => status).sort()).toEqual([200, 409]);
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS count FROM admins").first<{
        count: number;
      }>("count"),
    ).toBe(1);
  });

  it("rejects invalid administrator names as client input", async () => {
    await expectControlError(
      await jsonRequest("/api/v1/bootstrap", {
        ...bootstrapBody,
        username: "contains spaces",
      }),
      400,
      "invalid_request",
    );
    await expectControlError(
      await jsonRequest("/api/v1/auth/login", {
        schemaVersion: 1,
        username: "x",
        password: "wrong",
        rememberDevice: false,
      }),
      400,
      "invalid_request",
    );
  });

  it("rolls back login credentials when the success audit cannot commit", async () => {
    await bootstrapAdmin();
    await loginAdmin();
    await env.DB.exec(
      "CREATE UNIQUE INDEX reject_login_audit ON audit_events ((1)) WHERE action = 'auth.login' AND outcome = 'success'",
    );
    try {
      await expect(
        repository().login({
          username: bootstrapBody.username,
          password: bootstrapBody.password,
        }),
      ).rejects.toThrow(/reject_login_audit/u);
      expect(await count("auth_sessions")).toBe(2);
      expect(await count("access_tokens")).toBe(2);
    } finally {
      await env.DB.exec("DROP INDEX reject_login_audit");
    }
  });

  it("rolls back refresh rotation when the success audit cannot commit", async () => {
    const initial = await bootstrapAdmin();
    const auth = repository();
    const first = await auth.refresh(initial.refreshToken);
    expect(first).not.toBeNull();
    await env.DB.exec(
      "CREATE UNIQUE INDEX reject_refresh_audit ON audit_events ((1)) WHERE action = 'token.refresh' AND outcome = 'success'",
    );
    try {
      await expect(auth.refresh(first!.refreshToken)).rejects.toThrow(
        /reject_refresh_audit/u,
      );
      expect(await count("refresh_token_history")).toBe(1);
    } finally {
      await env.DB.exec("DROP INDEX reject_refresh_audit");
    }
    expect(await auth.refresh(first!.refreshToken)).not.toBeNull();
  });

  it("uses refresh CAS and revokes the family on concurrent reuse", async () => {
    const initial = await bootstrapAdmin();
    const responses = await Promise.all([
      refresh(initial.refreshToken),
      refresh(initial.refreshToken),
    ]);
    expect(responses.map(({ status }) => status).sort()).toEqual([200, 401]);
    const success = responses.find(({ status }) => status === 200)!;
    const rotated = SessionTokenPairV1Schema.parse(await success.json());
    await expectControlError(
      await authorizedRequest(rotated.accessToken, "/api/v1/auth/sessions"),
      401,
      "unauthorized",
    );
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM audit_events WHERE action = 'refresh-token.reuse'",
      ).first<number>("count"),
    ).toBe(1);
  });

  it("aggregates unknown-user throttling without storing supplied names", async () => {
    for (let index = 0; index < 5; index += 1) {
      const response = await loginAs(`intruder-${index}`);
      expect(response.status).toBe(401);
      await response.body?.cancel();
    }
    await expectControlError(
      await loginAs("another-intruder"),
      423,
      "account_locked",
    );
    expect(await count("auth_login_state")).toBe(0);
    expect(await count("auth_unknown_login_state")).toBe(1);
  });

  it("refreshes session last-seen timestamps at a bounded cadence", async () => {
    const pair = await bootstrapAdmin();
    const old = "2026-01-01T00:00:00.000Z";
    await env.DB.prepare(
      "UPDATE auth_sessions SET last_used_at = ? WHERE id = ?",
    )
      .bind(old, pair.sessionId)
      .run();
    expect(
      (await authorizedRequest(pair.accessToken, "/api/v1/auth/sessions"))
        .status,
    ).toBe(200);
    const updated = await env.DB.prepare(
      "SELECT last_used_at FROM auth_sessions WHERE id = ?",
    )
      .bind(pair.sessionId)
      .first<{ last_used_at: string }>();
    expect(updated?.last_used_at).not.toBe(old);
  });

  it("expires pending TOTP enrollment and traces revoked session ids", async () => {
    const first = await bootstrapAdmin();
    const current = await loginAdmin();
    const preparedResponse = await authorizedRequest(
      current.accessToken,
      "/api/v1/auth/totp/prepare",
      { method: "POST" },
    );
    const prepared = TotpPrepareResponseV1Schema.parse(
      await preparedResponse.json(),
    );
    await env.DB.prepare(
      "UPDATE admins SET pending_totp_expires_at = ? WHERE id = (SELECT admin_id FROM auth_sessions WHERE id = ?)",
    )
      .bind("2026-01-01T00:00:00.000Z", current.sessionId)
      .run();
    await expectControlError(
      await authorizedRequest(current.accessToken, "/api/v1/auth/totp/enable", {
        method: "POST",
        body: {
          schemaVersion: 1,
          code: await generateTotp(
            prepared.secret,
            Math.floor(Date.now() / 30_000),
          ),
        },
      }),
      400,
      "invalid_totp",
    );
    const pending = await env.DB.prepare(
      "SELECT pending_totp_secret, pending_totp_expires_at FROM admins LIMIT 1",
    ).first<{
      pending_totp_secret: string | null;
      pending_totp_expires_at: string | null;
    }>();
    expect(pending).toEqual({
      pending_totp_secret: null,
      pending_totp_expires_at: null,
    });
    const revoked = await authorizedRequest(
      current.accessToken,
      `/api/v1/auth/sessions/${first.sessionId}`,
      { method: "DELETE" },
    );
    expect(revoked.status).toBe(200);
    const audit = await env.DB.prepare(
      "SELECT payload_json FROM audit_events WHERE action = 'session.revoke' ORDER BY occurred_at DESC LIMIT 1",
    ).first<{ payload_json: string }>();
    expect(audit?.payload_json).toContain(`session:${first.sessionId}`);
  });

  it("traces the identifier of a revoked execution credential", async () => {
    const { pair, credential } = await createCredential("trace-revocation");
    const response = await authorizedRequest(
      pair.accessToken,
      `/api/v1/tokens/execution/${credential.credential.id}`,
      { method: "DELETE" },
    );
    expect(response.status).toBe(200);
    const audit = await env.DB.prepare(
      "SELECT payload_json FROM audit_events WHERE action = 'execution-token.revoke' ORDER BY occurred_at DESC LIMIT 1",
    ).first<{ payload_json: string }>();
    expect(audit?.payload_json).toContain(
      `execution-token:${credential.credential.id}`,
    );
    expect(audit?.payload_json).not.toContain(credential.token);
  });
});

function refresh(refreshToken: string): Promise<Response> {
  return jsonRequest("/api/v1/auth/refresh", {
    schemaVersion: 1,
    refreshToken,
  });
}

function loginAs(username: string): Promise<Response> {
  return jsonRequest("/api/v1/auth/login", {
    schemaVersion: 1,
    username,
    password: "wrong",
    rememberDevice: false,
  });
}

async function count(table: string): Promise<number> {
  return (
    (
      await env.DB.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first<{
        count: number;
      }>()
    )?.count ?? 0
  );
}

function repository(): AuthRepository {
  return new AuthRepository(env.DB, {
    bootstrapSecret: process.env.BOOTSTRAP_SECRET,
    pepper: process.env.INSTANCE_PEPPER,
    encryptionKey: process.env.ENCRYPTION_KEY,
    auditSigningKey: process.env.AUDIT_SIGNING_KEY,
    accessTtlSeconds: 900,
    refreshTtlSeconds: 2_592_000,
  });
}
