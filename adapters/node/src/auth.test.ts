import { afterEach, describe, expect, it } from "vitest";

import { createTestServices } from "./test-helpers.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("Node authentication and audit storage", () => {
  it("bootstraps once and rotates refresh-token families", async () => {
    const services = await createTestServices();
    cleanups.push(services.cleanup);
    const bootstrapToken = await services.auth.ensureBootstrap();
    expect(bootstrapToken).toBeTypeOf("string");

    await expect(
      services.auth.bootstrap(
        "incorrect-token",
        "operator",
        "correct horse battery staple",
      ),
    ).rejects.toThrow("invalid or expired");

    const first = await services.auth.bootstrap(
      bootstrapToken!,
      "operator",
      "correct horse battery staple",
    );
    expect(await services.auth.authenticateAdmin(first.accessToken)).toMatch(
      /^admin_/u,
    );
    await expect(
      services.auth.bootstrap(
        bootstrapToken!,
        "other",
        "correct horse battery staple",
      ),
    ).rejects.toThrow();

    const rotated = await services.auth.refresh(first.refreshToken);
    expect(rotated.refreshToken).not.toBe(first.refreshToken);
    await expect(services.auth.refresh(first.refreshToken)).rejects.toThrow(
      "reuse detected",
    );
    await expect(services.auth.refresh(rotated.refreshToken)).rejects.toThrow();
  });

  it("issues scoped execution credentials and persists a valid audit chain", async () => {
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
    const issued = await services.auth.createExecutionToken(
      administratorId!,
      ["http"],
      ["https://example.com"],
    );
    expect(await services.auth.authenticateExecution(issued.token)).toEqual(
      issued.credential,
    );

    await services.database.integrityCheck();
    const audit = await services.audit.list(20);
    expect(audit.length).toBeGreaterThanOrEqual(2);
    const serialized = JSON.stringify(audit);
    expect(serialized).not.toContain(issued.token);
    expect(serialized).not.toContain("correct horse battery staple");
  });
});
