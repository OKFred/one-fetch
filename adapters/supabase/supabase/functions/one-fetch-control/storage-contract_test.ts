import { ControlErrorV1Schema } from "@one-fetch/protocol";

import {
  createDatabase,
  type Database,
  DatabaseError,
} from "../_shared/database.ts";
import { defaultConfig } from "./model.ts";
import {
  controlMigrationHistory,
  controlTestEnvironment,
  createControlTestHandler as createControlHandler,
} from "./test-support.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const environment = await controlTestEnvironment();
const admin = {
  adminId: "00000000-0000-4000-8000-000000000010",
  sessionId: "00000000-0000-4000-8000-000000000011",
  familyId: "00000000-0000-4000-8000-000000000012",
};
const executionPrincipal = {
  tokenId: "00000000-0000-4000-8000-000000000020",
  name: "test",
  scopes: { transports: ["http"], origins: ["*"], ports: [] },
  quotas: {
    requestsPerMinute: 60,
    burst: 10,
    concurrentHttp: 4,
    concurrentTunnels: 2,
    bytesPerDay: 1_073_741_824,
  },
  expiresAt: null,
};

async function expectControlError(
  response: Response,
  status: number,
  code: string,
): Promise<void> {
  const problem = ControlErrorV1Schema.parse(await response.json());
  assert(
    response.status === status,
    `expected ${status}, got ${response.status}`,
  );
  assert(
    problem.error.code === code,
    `expected ${code}, got ${problem.error.code}`,
  );
}

function request(path: string, init: RequestInit = {}): Request {
  return new Request(`${environment.controlBaseUrl}${path}`, init);
}

Deno.test(
  "Malformed login and refresh RPC results fail as storage drift",
  async () => {
    const loginDatabase: Database = {
      rpc: <T>(name: string) => {
        if (name === "of_begin_login_attempt") {
          return Promise.resolve({ allowed: true } as T);
        }
        if (name === "of_get_admin_for_login") {
          return Promise.resolve({ adminId: "not-a-uuid" } as T);
        }
        return Promise.reject(new Error(`unexpected RPC ${name}`));
      },
    };
    const login = await createControlHandler(
      environment,
      loginDatabase,
    )(
      request("/api/v1/auth/login", {
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
    await expectControlError(login, 503, "storage_contract_invalid");

    const refreshDatabase: Database = {
      rpc: <T>(name: string) => {
        if (name === "of_begin_auth_source_attempt") {
          return Promise.resolve({ allowed: true } as T);
        }
        if (name === "of_rotate_refresh_audited") {
          return Promise.resolve({ status: "future_protocol_status" } as T);
        }
        return Promise.reject(new Error(`unexpected RPC ${name}`));
      },
    };
    const refresh = await createControlHandler(
      environment,
      refreshDatabase,
    )(
      request("/api/v1/auth/refresh", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          schemaVersion: 1,
          refreshToken: `ofr_${"r".repeat(32)}`,
        }),
      }),
    );
    await expectControlError(refresh, 503, "storage_contract_invalid");
  },
);

Deno.test(
  "Malformed revoke results cannot become successful responses",
  async () => {
    const sessionDatabase: Database = {
      rpc: <T>(name: string) => {
        if (name === "of_authenticate_access")
          return Promise.resolve(admin as T);
        if (name === "of_revoke_session") return Promise.resolve("false" as T);
        return Promise.reject(new Error(`unexpected RPC ${name}`));
      },
    };
    const logout = await createControlHandler(
      environment,
      sessionDatabase,
    )(
      request("/api/v1/auth/logout", {
        method: "POST",
        headers: { authorization: "Bearer ofa_test-token" },
      }),
    );
    await expectControlError(logout, 503, "storage_contract_invalid");

    const tokenDatabase: Database = {
      rpc: <T>(name: string) => {
        if (name === "of_authenticate_access")
          return Promise.resolve(admin as T);
        if (name === "of_revoke_execution_token") {
          return Promise.resolve("false" as T);
        }
        return Promise.reject(new Error(`unexpected RPC ${name}`));
      },
    };
    const tokenId = "00000000-0000-4000-8000-000000000021";
    const revoked = await createControlHandler(
      environment,
      tokenDatabase,
    )(
      request(`/api/v1/tokens/execution/${tokenId}`, {
        method: "DELETE",
        headers: { authorization: "Bearer ofa_test-token" },
      }),
    );
    await expectControlError(revoked, 503, "storage_contract_invalid");
  },
);

Deno.test(
  "Malformed list and report records fail at the storage boundary",
  async () => {
    const sessionsDatabase: Database = {
      rpc: <T>(name: string) => {
        if (name === "of_authenticate_access")
          return Promise.resolve(admin as T);
        if (name === "of_list_sessions") {
          return Promise.resolve([
            { schemaVersion: 1, id: "missing-fields" },
          ] as T);
        }
        return Promise.reject(new Error(`unexpected RPC ${name}`));
      },
    };
    const sessions = await createControlHandler(
      environment,
      sessionsDatabase,
    )(
      request("/api/v1/auth/sessions", {
        headers: { authorization: "Bearer ofa_test-token" },
      }),
    );
    await expectControlError(sessions, 503, "storage_contract_invalid");

    const reportDatabase: Database = {
      rpc: <T>(name: string) => {
        if (name === "of_authenticate_execution") {
          return Promise.resolve(executionPrincipal as T);
        }
        if (name === "of_get_execution_report") {
          return Promise.resolve({ schemaVersion: 1, responseBytes: -1 } as T);
        }
        return Promise.reject(new Error(`unexpected RPC ${name}`));
      },
    };
    const reportId = "00000000-0000-4000-8000-000000000022";
    const report = await createControlHandler(
      environment,
      reportDatabase,
    )(
      request(`/api/v1/reports/${reportId}`, {
        headers: { authorization: "Bearer ofe_test-token" },
      }),
    );
    await expectControlError(report, 503, "storage_contract_invalid");
  },
);

Deno.test(
  "Health and configuration reject a different stored instance",
  async () => {
    const otherInstance = "00000000-0000-4000-8000-000000000099";
    const migrations = await controlMigrationHistory();
    const healthDatabase: Database = {
      rpc: <T>() =>
        Promise.resolve({
          instanceId: otherInstance,
          initialized: true,
          auditDegraded: false,
          migrations,
        } as T),
    };
    const health = await createControlHandler(
      environment,
      healthDatabase,
    )(request("/api/v1/health"));
    await expectControlError(health, 503, "instance_mismatch");

    const configurationDatabase: Database = {
      rpc: <T>(name: string) => {
        if (name === "of_authenticate_access")
          return Promise.resolve(admin as T);
        if (name === "of_get_active_config") {
          return Promise.resolve({
            instanceId: otherInstance,
            initialized: true,
            gatewayPaused: false,
            revision: 0,
            version: "20260904T000000.000Z-test",
            config: defaultConfig(),
            updatedAt: "2026-09-04T00:00:00.000Z",
            auditDegraded: false,
          } as T);
        }
        return Promise.reject(new Error(`unexpected RPC ${name}`));
      },
    };
    const configuration = await createControlHandler(
      environment,
      configurationDatabase,
    )(
      request("/api/v1/config", {
        headers: { authorization: "Bearer ofa_test-token" },
      }),
    );
    await expectControlError(configuration, 503, "instance_mismatch");
  },
);

Deno.test(
  "Initialized health requires a stored instance identity",
  async () => {
    const migrations = await controlMigrationHistory();
    const database: Database = {
      rpc: <T>() =>
        Promise.resolve({
          initialized: true,
          auditDegraded: false,
          migrations,
        } as T),
    };
    const health = await createControlHandler(
      environment,
      database,
    )(request("/api/v1/health"));
    await expectControlError(health, 503, "storage_contract_invalid");
  },
);

async function expectDatabaseFailure(
  operation: () => Promise<unknown>,
  code: string,
): Promise<void> {
  try {
    await operation();
    throw new Error("expected database operation to fail");
  } catch (error) {
    assert(error instanceof DatabaseError, "failure was not a DatabaseError");
    assert(error.status === 503, `expected storage 503, got ${error.status}`);
    assert(error.code === code, `expected ${code}, got ${error.code}`);
  }
}

Deno.test(
  "Database transport, timeout, and invalid JSON become 503 errors",
  async () => {
    const transport = createDatabase(environment, {
      fetch: () => Promise.reject(new TypeError("network unavailable")),
    });
    await expectDatabaseFailure(
      () => transport.rpc("of_transport_test"),
      "database_transport",
    );
    await expectControlError(
      await createControlHandler(
        environment,
        transport,
      )(request("/api/v1/health")),
      503,
      "storage_unavailable",
    );

    const invalidJson = createDatabase(environment, {
      fetch: () => Promise.resolve(new Response("not-json", { status: 200 })),
    });
    await expectDatabaseFailure(
      () => invalidJson.rpc("of_invalid_json_test"),
      "database_invalid_json",
    );

    const timedOut = createDatabase(environment, {
      timeoutMs: 5,
      fetch: (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (!signal) return reject(new Error("missing timeout signal"));
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        }),
    });
    await expectDatabaseFailure(
      () => timedOut.rpc("of_timeout_test"),
      "database_timeout",
    );
  },
);
