import { afterEach, describe, expect, it } from "vitest";

import type { SessionTokenPairV1 } from "@one-fetch/protocol";

import { createTestServices } from "./test-helpers.js";

const USERNAME = "operator";
const PASSWORD = "correct horse battery staple";
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

const fulfilled = (
  results: PromiseSettledResult<SessionTokenPairV1>[],
): PromiseFulfilledResult<SessionTokenPairV1>[] =>
  results.filter(
    (result): result is PromiseFulfilledResult<SessionTokenPairV1> =>
      result.status === "fulfilled",
  );

describe("Node authentication concurrency", () => {
  it("consumes one bootstrap token once and enforces one administrator", async () => {
    const services = await createTestServices();
    cleanups.push(services.cleanup);
    const token = await services.auth.ensureBootstrap();

    const results = await Promise.allSettled([
      services.auth.bootstrap(token!, USERNAME, PASSWORD),
      services.auth.bootstrap(token!, "other-operator", PASSWORD),
    ]);

    expect(fulfilled(results)).toHaveLength(1);
    expect(results.filter(({ status }) => status === "rejected")).toHaveLength(
      1,
    );
    expect(
      await services.database.get<{ count: number }>(
        "SELECT COUNT(*) AS count FROM administrators",
      ),
    ).toEqual({ count: 1 });
    expect(
      await services.database.get<{ count: number }>(
        "SELECT COUNT(*) AS count FROM auth_tokens",
      ),
    ).toEqual({ count: 2 });

    await expect(
      services.database.run(
        `INSERT INTO administrators(
             id, username, password_hash, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?)`,
        ["admin_second", "second", "unused", "now", "now"],
      ),
    ).rejects.toThrow(/UNIQUE constraint failed/u);
  }, 30_000);

  it("allows one concurrent refresh rotation and revokes the raced family", async () => {
    const services = await createTestServices();
    cleanups.push(services.cleanup);
    const token = await services.auth.ensureBootstrap();
    const initial = await services.auth.bootstrap(token!, USERNAME, PASSWORD);

    const results = await Promise.allSettled([
      services.auth.refresh(initial.refreshToken),
      services.auth.refresh(initial.refreshToken),
    ]);
    const winners = fulfilled(results);

    expect(winners).toHaveLength(1);
    expect(results.filter(({ status }) => status === "rejected")).toHaveLength(
      1,
    );
    expect(
      await services.auth.authenticateAdmin(winners[0]!.value.accessToken),
    ).toBeUndefined();
    await expect(
      services.auth.refresh(winners[0]!.value.refreshToken),
    ).rejects.toThrow("reuse detected");
    expect(
      await services.database.get<{ count: number }>(
        "SELECT COUNT(*) AS count FROM auth_tokens WHERE revoked_at IS NULL",
      ),
    ).toEqual({ count: 0 });
    expect(
      await services.database.get<{ count: number }>(
        "SELECT COUNT(*) AS count FROM auth_tokens",
      ),
    ).toEqual({ count: 4 });
  }, 30_000);

  it("increments and locks concurrent failed logins without lost updates", async () => {
    const services = await createTestServices();
    cleanups.push(services.cleanup);
    const token = await services.auth.ensureBootstrap();
    await services.auth.bootstrap(token!, USERNAME, PASSWORD);

    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () =>
        services.auth.login(USERNAME, "definitely incorrect"),
      ),
    );

    expect(results.every(({ status }) => status === "rejected")).toBe(true);
    const state = await services.database.get<{
      failed_attempts: number;
      locked_until: string | null;
    }>(
      "SELECT failed_attempts, locked_until FROM administrators WHERE username = ?",
      [USERNAME],
    );
    expect(state?.failed_attempts).toBe(8);
    expect(state?.locked_until).not.toBeNull();
    expect(
      await services.database.get<{ count: number }>(
        "SELECT COUNT(*) AS count FROM audit_events WHERE action = 'auth.login.failure'",
      ),
    ).toEqual({ count: 8 });
    await expect(services.auth.login(USERNAME, PASSWORD)).rejects.toMatchObject(
      { code: "invalid_credentials" },
    );
  }, 30_000);

  it("allows only one concurrent password change from the same old hash", async () => {
    const services = await createTestServices();
    cleanups.push(services.cleanup);
    const token = await services.auth.ensureBootstrap();
    const initial = await services.auth.bootstrap(token!, USERNAME, PASSWORD);
    const administratorId = await services.auth.authenticateAdmin(
      initial.accessToken,
    );
    expect(administratorId).toBeDefined();

    const results = await Promise.all([
      services.auth.changePassword(
        administratorId!,
        initial.sessionId,
        PASSWORD,
        "first replacement password",
      ),
      services.auth.changePassword(
        administratorId!,
        initial.sessionId,
        PASSWORD,
        "second replacement password",
      ),
    ]);

    expect(results.filter((result) => result !== undefined)).toHaveLength(1);
    expect(
      await services.database.get<{ count: number }>(
        "SELECT COUNT(*) AS count FROM audit_events WHERE action = 'auth.password.change'",
      ),
    ).toEqual({ count: 1 });
  }, 30_000);
});
