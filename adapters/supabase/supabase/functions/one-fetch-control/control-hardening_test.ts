import { ControlErrorV1Schema } from "@one-fetch/protocol";

import type { Database } from "../_shared/database.ts";
import { hmacSha256Hex } from "../_shared/crypto.ts";
import { loginThrottleKeys } from "./helpers.ts";
import {
  controlMigrationHistory,
  controlTestEnvironment,
  createControlTestHandler as createControlHandler,
} from "./test-support.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

Deno.test(
  "Control rejects oversized and malformed JSON before storage",
  async () => {
    const environment = await controlTestEnvironment();
    const database: Database = {
      rpc: () => Promise.reject(new Error("body validation reached storage")),
    };
    const handler = createControlHandler(environment, database);
    const oversized = await handler(
      new Request(`${environment.controlBaseUrl}/api/v1/bootstrap`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: `"${"x".repeat(1_048_576)}"`,
      }),
    );
    assert(oversized.status === 413, `expected 413, got ${oversized.status}`);
    const malformed = await handler(
      new Request(`${environment.controlBaseUrl}/api/v1/bootstrap`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{",
      }),
    );
    assert(malformed.status === 400, `expected 400, got ${malformed.status}`);
  },
);

Deno.test(
  "Login throttle rejects before account lookup and bcrypt",
  async () => {
    const environment = await controlTestEnvironment();
    const calls: string[] = [];
    const database: Database = {
      rpc: <T>(name: string) => {
        calls.push(name);
        if (name === "of_begin_login_attempt") {
          return Promise.resolve({ allowed: false } as T);
        }
        return Promise.reject(new Error(`unexpected RPC ${name}`));
      },
    };
    const response = await createControlHandler(
      environment,
      database,
    )(
      new Request(`${environment.controlBaseUrl}/api/v1/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          schemaVersion: 1,
          username: "missing-user",
          password: "not-the-password",
          rememberDevice: false,
        }),
      }),
    );
    assert(response.status === 401, `expected 401, got ${response.status}`);
    assert(
      calls.join(",") === "of_begin_login_attempt",
      `unexpected RPC sequence ${calls.join(",")}`,
    );
  },
);

Deno.test(
  "Request validation stays distinct from storage contract drift",
  async () => {
    const environment = await controlTestEnvironment();
    const handler = createControlHandler(environment, {
      rpc: <T>(name: string) => {
        assert(name === "of_begin_login_attempt", `unexpected RPC ${name}`);
        return Promise.resolve({ allowed: "not-a-boolean" } as T);
      },
    });
    const invalidRequest = await handler(
      new Request(`${environment.controlBaseUrl}/api/v1/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ schemaVersion: 1 }),
      }),
    );
    assert(
      invalidRequest.status === 400,
      `expected request 400, got ${invalidRequest.status}`,
    );
    const storageDrift = await handler(
      new Request(`${environment.controlBaseUrl}/api/v1/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          schemaVersion: 1,
          username: "administrator",
          password: "not-the-password",
          rememberDevice: false,
        }),
      }),
    );
    const problem = ControlErrorV1Schema.parse(await storageDrift.json());
    assert(
      storageDrift.status === 503,
      `expected 503, got ${storageDrift.status}`,
    );
    assert(
      problem.error.code === "storage_contract_invalid",
      "storage drift did not use its canonical error",
    );
  },
);

Deno.test(
  "Bootstrap and refresh source throttles reject before expensive work",
  async () => {
    const environment = await controlTestEnvironment();
    const calls: Array<{ name: string; parameters?: Record<string, unknown> }> =
      [];
    const handler = createControlHandler(environment, {
      rpc: <T>(name: string, parameters?: Record<string, unknown>) => {
        calls.push(parameters ? { name, parameters } : { name });
        return Promise.resolve({ allowed: false } as T);
      },
    });
    const bootstrap = await handler(
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
    const refresh = await handler(
      new Request(`${environment.controlBaseUrl}/api/v1/auth/refresh`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          schemaVersion: 1,
          refreshToken: `ofr_${"r".repeat(32)}`,
        }),
      }),
    );
    assert(
      bootstrap.status === 401,
      `expected bootstrap 401, got ${bootstrap.status}`,
    );
    assert(
      refresh.status === 401,
      `expected refresh 401, got ${refresh.status}`,
    );
    assert(calls.length === 2, `unexpected RPC count ${calls.length}`);
    assert(
      calls[0]?.name === "of_begin_auth_source_attempt" &&
        calls[0].parameters?.p_kind === "bootstrap-source",
      "bootstrap did not use its source throttle",
    );
    assert(
      calls[1]?.name === "of_begin_auth_source_attempt" &&
        calls[1].parameters?.p_kind === "refresh-source",
      "refresh did not use its source throttle",
    );
  },
);

Deno.test(
  "Login throttling uses the managed platform client address",
  async () => {
    const environment = await controlTestEnvironment();
    const keys = await loginThrottleKeys(
      new Request(`${environment.controlBaseUrl}/api/v1/auth/login`, {
        headers: {
          "cf-connecting-ip": "198.51.100.10",
          "x-real-ip": "198.51.100.11",
          "x-forwarded-for": "203.0.113.7, 192.0.2.4",
        },
      }),
      "Administrator",
      environment,
    );
    assert(
      keys.sourceHash ===
        (await hmacSha256Hex(environment.pepper, "login-source\n203.0.113.7")),
      "the managed platform client address was not used",
    );
    assert(
      keys.usernameHash ===
        (await hmacSha256Hex(
          environment.pepper,
          "login-username\nadministrator",
        )),
      "username throttle key was not normalized",
    );
  },
);

Deno.test(
  "Health reflects audit degradation",
  async () => {
    const environment = await controlTestEnvironment();
    const migrations = await controlMigrationHistory();
    const degradedDatabase: Database = {
      rpc: <T>() =>
        Promise.resolve({
          instanceId: environment.instanceId,
          initialized: true,
          auditDegraded: true,
          migrations,
        } as T),
    };
    const degraded = await createControlHandler(
      environment,
      degradedDatabase,
    )(new Request(`${environment.controlBaseUrl}/api/v1/health`));
    assert(degraded.status === 200, `expected 200, got ${degraded.status}`);
    assert(
      ((await degraded.json()) as { status?: string }).status === "degraded",
      "health did not expose audit degradation",
    );
  },
);

Deno.test(
  "Tampered audit rows fail closed and persist degradation",
  async () => {
    const environment = await controlTestEnvironment();
    const calls: string[] = [];
    const database: Database = {
      rpc: <T>(name: string) => {
        calls.push(name);
        if (name === "of_authenticate_access") {
          return Promise.resolve({
            adminId: "00000000-0000-4000-8000-000000000010",
            sessionId: "00000000-0000-4000-8000-000000000011",
            familyId: "00000000-0000-4000-8000-000000000012",
          } as T);
        }
        if (name === "of_list_audit") {
          return Promise.resolve([
            {
              sequence: 1,
              payload: {
                schemaVersion: 1,
                eventId: "00000000-0000-4000-8000-000000000020",
                occurredAt: "2026-09-04T00:00:00.000Z",
                recordedAt: "2026-09-04T00:00:00.000Z",
                category: "audit",
                action: "tampered",
                outcome: "failure",
                severity: "critical",
                actor: { type: "system" },
                correlation: {},
              },
              payloadHash: "0".repeat(64),
              signature: "dGVzdA",
              keyId: environment.auditKeyId,
            },
          ] as T);
        }
        if (name === "of_mark_audit_degraded") {
          return Promise.resolve(true as T);
        }
        return Promise.reject(new Error(`unexpected RPC ${name}`));
      },
    };
    const response = await createControlHandler(
      environment,
      database,
    )(
      new Request(`${environment.controlBaseUrl}/api/v1/audit`, {
        headers: { authorization: "Bearer ofa_test-token" },
      }),
    );
    const problem = ControlErrorV1Schema.parse(await response.json());
    assert(response.status === 503, `expected 503, got ${response.status}`);
    assert(
      problem.error.code === "audit_integrity_failure",
      "wrong integrity error",
    );
    assert(
      calls.join(",") ===
        "of_authenticate_access,of_list_audit,of_mark_audit_degraded",
      `unexpected RPC sequence ${calls.join(",")}`,
    );
  },
);
