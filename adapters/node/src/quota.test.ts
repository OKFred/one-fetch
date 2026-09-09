import type { ExecutionCredential } from "./execution-tokens.js";
import { afterEach, describe, expect, it } from "vitest";

import { GatewayFailure } from "./gateway-error.js";
import { QuotaCoordinator } from "./quota.js";
import { createTestServices } from "./test-helpers.js";

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

const credential = (
  id: string,
  overrides: Partial<ExecutionCredential["quota"]> = {},
): ExecutionCredential => {
  const quota = {
    burst: 10,
    bytesPerDay: 100,
    concurrentHttp: 2,
    concurrentTunnels: 1,
    requestsPerMinute: 60,
    ...overrides,
  };
  return {
    allowedOrigins: ["https://example.com"],
    allowedPorts: [],
    createdAt: "2026-09-04T00:00:00.000Z",
    id,
    name: id,
    quota,
    schemaVersion: 1,
    scope: {
      origins: ["https://example.com"],
      ports: [],
      transports: ["http", "websocket"],
    },
    scopes: ["http", "websocket"],
  };
};

const expectQuotaFailure = async (operation: Promise<unknown>) => {
  const error = await operation.catch((reason: unknown) => reason);
  expect(error).toBeInstanceOf(GatewayFailure);
  expect((error as GatewayFailure).problem.code).toBe("quota_exceeded");
};

describe("Node execution quotas", () => {
  it("enforces and releases HTTP and tunnel concurrency independently", async () => {
    const services = await createTestServices();
    cleanups.push(services.cleanup);
    const subject = credential("exec_concurrency", {
      concurrentHttp: 1,
      concurrentTunnels: 1,
    });
    const http = await services.quota.acquire(subject, "http");
    const tunnel = await services.quota.acquire(subject, "tunnel");

    await expectQuotaFailure(services.quota.acquire(subject, "http"));
    await expectQuotaFailure(services.quota.acquire(subject, "tunnel"));

    await http.release();
    await tunnel.release();
    const next = await services.quota.acquire(subject, "http");
    await next.release();
  });

  it("persists token-bucket state across coordinator restarts", async () => {
    const services = await createTestServices();
    cleanups.push(services.cleanup);
    let now = Date.parse("2026-09-04T00:00:00.000Z");
    const subject = credential("exec_rate", { burst: 1 });
    const first = new QuotaCoordinator(services.database, () => now);
    await (await first.acquire(subject, "http")).release();

    const restarted = new QuotaCoordinator(services.database, () => now);
    await expectQuotaFailure(restarted.acquire(subject, "http"));

    now += 60_000;
    await (await restarted.acquire(subject, "http")).release();
  });

  it("persists and rejects daily byte overages without partial charging", async () => {
    const services = await createTestServices();
    cleanups.push(services.cleanup);
    let now = Date.parse("2026-09-04T00:00:00.000Z");
    const subject = credential("exec_bytes", { bytesPerDay: 5 });
    const first = new QuotaCoordinator(services.database, () => now);
    const lease = await first.acquire(subject, "http", 3);

    await expectQuotaFailure(lease.chargeBytes(3));
    await lease.release();

    now += 60_000;
    const restarted = new QuotaCoordinator(services.database, () => now);
    await expectQuotaFailure(restarted.acquire(subject, "http", 3));
    const remaining = await restarted.acquire(subject, "http", 2);
    await remaining.release();
  });
});
