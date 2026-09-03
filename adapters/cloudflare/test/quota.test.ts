import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { DEFAULT_QUOTA } from "../src/types";

describe("per-token QuotaDurableObject", () => {
  it("enforces concurrency and releases the lease", async () => {
    const quota = env.QUOTA.getByName("quota-concurrency");
    const now = Date.now();
    for (let index = 0; index < DEFAULT_QUOTA.concurrentHttp; index += 1) {
      const result = await quota.acquire({
        requestId: `request-${index}`,
        transport: "http",
        now,
        requestBytes: 1,
        leaseTtlMs: 60_000,
        limits: DEFAULT_QUOTA,
      });
      expect(result.allowed).toBe(true);
    }
    const duplicate = await quota.acquire({
      requestId: "request-0",
      transport: "http",
      now,
      requestBytes: 1,
      leaseTtlMs: 60_000,
      limits: DEFAULT_QUOTA,
    });
    expect(duplicate).toMatchObject({
      allowed: false,
      code: "concurrency_limited",
    });
    const denied = await quota.acquire({
      requestId: "request-over",
      transport: "http",
      now,
      requestBytes: 1,
      leaseTtlMs: 60_000,
      limits: DEFAULT_QUOTA,
    });
    expect(denied).toMatchObject({
      allowed: false,
      code: "concurrency_limited",
    });
    await quota.release("request-0", 10, 1, now);
    const retry = await quota.acquire({
      requestId: "request-retry",
      transport: "http",
      now,
      requestBytes: 1,
      leaseTtlMs: 60_000,
      limits: DEFAULT_QUOTA,
    });
    expect(retry.allowed).toBe(true);
  });

  it("isolates quota state by execution token", async () => {
    const first = env.QUOTA.getByName("token-a");
    const second = env.QUOTA.getByName("token-b");
    const now = Date.now();
    await first.acquire({
      requestId: "a",
      transport: "http",
      now,
      requestBytes: 100,
      leaseTtlMs: 60_000,
      limits: DEFAULT_QUOTA,
    });
    expect((await first.snapshot(now)).activeHttp).toBe(1);
    expect((await second.snapshot(now)).activeHttp).toBe(0);
  });
});
