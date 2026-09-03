import {
  ChangePasswordResponseV1Schema,
  ControlErrorV1Schema,
  SessionTokenPairV1Schema,
} from "@one-fetch/protocol";

import { hashPassword } from "../_shared/auth.ts";
import type { Database } from "../_shared/database.ts";
import type { SupabaseEnvironment } from "../_shared/env.ts";
import { createControlHandler } from "./handler.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function base64Url(bytes: ArrayBuffer): string {
  let binary = "";
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

async function testEnvironment(): Promise<SupabaseEnvironment> {
  const keyPair = await crypto.subtle.generateKey("Ed25519", true, [
    "sign",
    "verify",
  ]);
  if (!("privateKey" in keyPair)) {
    throw new TypeError("Ed25519 key generation did not return a key pair");
  }
  return {
    instanceId: "00000000-0000-4000-8000-000000000001",
    bootstrapSecret: "b".repeat(32),
    pepper: "p".repeat(32),
    auditSigningPrivateKey: base64Url(
      await crypto.subtle.exportKey("pkcs8", keyPair.privateKey),
    ),
    auditKeyId: "test",
    supabaseUrl: "https://example.supabase.co",
    serviceRoleKey: "test-service-role",
    controlBaseUrl: "https://control.example",
    gatewayBaseUrl: "https://gateway.example",
    allowedAdminOrigins: ["https://admin.example"],
    allowedClientOrigins: [],
    buildVersion: "test",
  };
}

Deno.test("Bootstrap returns a canonical administrator session", async () => {
  const environment = await testEnvironment();
  const calls: string[] = [];
  const database: Database = {
    rpc: <T>(name: string) => {
      calls.push(name);
      if (name === "of_begin_auth_source_attempt") {
        return Promise.resolve({ allowed: true } as T);
      }
      if (name === "of_bootstrap_admin_session") {
        return Promise.resolve({
          status: "created",
          sessionId: "00000000-0000-4000-8000-000000000011",
        } as T);
      }
      throw new Error(`unexpected RPC ${name}`);
    },
  };
  const response = await createControlHandler(
    environment,
    database,
  )(
    new Request(`${environment.controlBaseUrl}/api/v1/bootstrap`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        schemaVersion: 1,
        bootstrapSecret: environment.bootstrapSecret,
        username: "administrator",
        password: "correct horse battery staple",
      }),
    }),
  );
  const body = SessionTokenPairV1Schema.parse(await response.json());
  assert(response.status === 200, `expected 200, got ${response.status}`);
  assert(body.accessToken.startsWith("ofa_"), "access token prefix was lost");
  assert(
    calls.join(",") ===
      "of_begin_auth_source_attempt,of_bootstrap_admin_session",
    `unexpected RPC sequence ${calls.join(",")}`,
  );
});

Deno.test("Bootstrap failures use the canonical generic response", async () => {
  const environment = await testEnvironment();
  const calls: string[] = [];
  const database: Database = {
    rpc: <T>(name: string) => {
      calls.push(name);
      if (name === "of_begin_auth_source_attempt") {
        return Promise.resolve({ allowed: true } as T);
      }
      if (name === "of_append_audit") return Promise.resolve(undefined as T);
      return Promise.reject(new Error("invalid bootstrap reached storage"));
    },
  };
  const response = await createControlHandler(
    environment,
    database,
  )(
    new Request(`${environment.controlBaseUrl}/api/v1/bootstrap`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        schemaVersion: 1,
        bootstrapSecret: "x".repeat(32),
        username: "administrator",
        password: "correct horse battery staple",
      }),
    }),
  );
  const body = ControlErrorV1Schema.parse(await response.json());
  assert(response.status === 401, `expected 401, got ${response.status}`);
  assert(body.error.code === "bootstrap_failed", "failure code leaked detail");
  assert(
    calls.join(",") === "of_begin_auth_source_attempt,of_append_audit",
    "bootstrap failure was not audited",
  );
});

Deno.test(
  "An initialized instance uses the generic bootstrap failure",
  async () => {
    const environment = await testEnvironment();
    const database: Database = {
      rpc: <T>(name: string) => {
        if (name === "of_begin_auth_source_attempt") {
          return Promise.resolve({ allowed: true } as T);
        }
        if (name === "of_bootstrap_admin_session") {
          return Promise.resolve({ status: "already_initialized" } as T);
        }
        return Promise.reject(new Error(`unexpected RPC ${name}`));
      },
    };
    const response = await createControlHandler(
      environment,
      database,
    )(
      new Request(`${environment.controlBaseUrl}/api/v1/bootstrap`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          schemaVersion: 1,
          bootstrapSecret: environment.bootstrapSecret,
          username: "administrator",
          password: "correct horse battery staple",
        }),
      }),
    );
    const body = ControlErrorV1Schema.parse(await response.json());
    assert(response.status === 401, `expected 401, got ${response.status}`);
    assert(body.error.code === "bootstrap_failed", "failure code leaked state");
  },
);

Deno.test(
  "Password changes preserve the current session and return revoked IDs",
  async () => {
    const environment = await testEnvironment();
    const currentPassword = "old correct horse battery staple";
    const currentHash = await hashPassword(currentPassword, environment);
    const database: Database = {
      rpc: <T>(name: string, parameters?: Record<string, unknown>) => {
        if (name === "of_authenticate_access") {
          return Promise.resolve({
            adminId: "00000000-0000-4000-8000-000000000010",
            sessionId: "00000000-0000-4000-8000-000000000011",
            familyId: "00000000-0000-4000-8000-000000000012",
          } as T);
        }
        if (name === "of_get_admin_for_password_change") {
          return Promise.resolve({ passwordHash: currentHash } as T);
        }
        if (name === "of_change_password") {
          assert(
            parameters?.p_current_session_id ===
              "00000000-0000-4000-8000-000000000011",
            "current session was not preserved",
          );
          return Promise.resolve({
            schemaVersion: 1,
            changedAt: "2026-09-04T00:00:00.000Z",
            revokedSessionIds: ["00000000-0000-4000-8000-000000000099"],
          } as T);
        }
        throw new Error(`unexpected RPC ${name}`);
      },
    };
    const response = await createControlHandler(
      environment,
      database,
    )(
      new Request(`${environment.controlBaseUrl}/api/v1/auth/password`, {
        method: "POST",
        headers: {
          authorization: "Bearer ofa_test-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          schemaVersion: 1,
          currentPassword,
          newPassword: "new correct horse battery staple",
        }),
      }),
    );
    const body = ChangePasswordResponseV1Schema.parse(await response.json());
    assert(response.status === 200, `expected 200, got ${response.status}`);
    assert(
      body.revokedSessionIds.length === 1,
      "revoked sessions were omitted",
    );
  },
);
