import { ControlErrorV1Schema } from "@one-fetch/protocol";

import { type Database, DatabaseError } from "../_shared/database.ts";
import { createControlHandler } from "./handler.ts";
import {
  controlMigrationHistory,
  controlTestEnvironment,
} from "./test-support.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function expectError(response: Response, code: string): Promise<void> {
  const body = ControlErrorV1Schema.parse(await response.json());
  assert(response.status === 503, `expected 503, got ${response.status}`);
  assert(body.error.code === code, `expected ${code}, got ${body.error.code}`);
}

const environment = await controlTestEnvironment();

Deno.test("Every Control route checks migration compatibility first", async () => {
  const changed = controlMigrationHistory();
  changed[0] = { ...changed[0]!, checksum: "0".repeat(64) };
  const calls: string[] = [];
  const database: Database = {
    rpc: <T>(name: string) => {
      calls.push(name);
      if (name === "of_get_migration_integrity") {
        return Promise.resolve(changed as T);
      }
      return Promise.reject(new Error(`business RPC reached: ${name}`));
    },
  };
  const handler = createControlHandler(environment, database);
  const requests = [
    new Request(`${environment.controlBaseUrl}/api/v1/health`),
    new Request(`${environment.controlBaseUrl}/api/v1/capabilities`),
    new Request(`${environment.controlBaseUrl}/api/v1/openapi.json`),
    new Request(`${environment.controlBaseUrl}/api/v1/bootstrap`),
    new Request(`${environment.controlBaseUrl}/api/v1/config`),
    new Request(`${environment.controlBaseUrl}/api/v1/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }),
    new Request(`${environment.controlBaseUrl}/api/v1/not-found`),
  ];
  for (const request of requests) {
    await expectError(await handler(request), "schema_incompatible");
  }
  assert(
    calls.every((name) => name === "of_get_migration_integrity"),
    `a Control business RPC ran: ${calls.join(",")}`,
  );
});

Deno.test("Control distinguishes migration mismatch, contract, and storage failures", async () => {
  const compatible = controlMigrationHistory();
  const fixtures: Array<{ result: unknown; code: string }> = [
    { result: compatible.slice(0, -1), code: "schema_incompatible" },
    {
      result: [
        ...compatible,
        { version: "999999999999", checksum: "1".repeat(64) },
      ],
      code: "schema_incompatible",
    },
    {
      result: compatible.map((entry, index) =>
        index === 0 ? { ...entry, checksum: "2".repeat(64) } : entry
      ),
      code: "schema_incompatible",
    },
    { result: { migrations: compatible }, code: "storage_contract_invalid" },
  ];
  for (const fixture of fixtures) {
    const database: Database = {
      rpc: <T>() => Promise.resolve(fixture.result as T),
    };
    await expectError(
      await createControlHandler(environment, database)(
        new Request(`${environment.controlBaseUrl}/api/v1/openapi.json`),
      ),
      fixture.code,
    );
  }

  const unavailable: Database = {
    rpc: () =>
      Promise.reject(
        new DatabaseError(
          "migration storage unavailable",
          503,
          "database_transport",
        ),
      ),
  };
  await expectError(
    await createControlHandler(environment, unavailable)(
      new Request(`${environment.controlBaseUrl}/api/v1/openapi.json`),
    ),
    "storage_unavailable",
  );
});

Deno.test("A successful Control migration check is briefly shared", async () => {
  let checks = 0;
  const database: Database = {
    rpc: <T>(name: string) => {
      if (name !== "of_get_migration_integrity") {
        return Promise.reject(new Error(`unexpected RPC ${name}`));
      }
      checks += 1;
      return Promise.resolve(controlMigrationHistory() as T);
    },
  };
  const handler = createControlHandler(environment, database);
  const url = `${environment.controlBaseUrl}/api/v1/openapi.json`;
  assert(
    (await handler(new Request(url))).status === 200,
    "first request failed",
  );
  assert(
    (await handler(new Request(url))).status === 200,
    "second request failed",
  );
  assert(checks === 1, `expected one compatibility RPC, got ${checks}`);
});
