import type { ExecutionQuotaV1 } from "@one-fetch/protocol";

import type { DatabaseClient } from "./database.js";
import type { SqlOperation } from "./database-protocol.js";
import type { ExecutionCredential } from "./execution-tokens.js";
import { failure } from "./gateway-error.js";

const INSTANCE_QUOTA: ExecutionQuotaV1 = {
  burst: 300,
  bytesPerDay: 10 * 1024 * 1024 * 1024,
  concurrentHttp: 20,
  concurrentTunnels: 8,
  requestsPerMinute: 300,
};
const INSTANCE_KEY = "__instance__";

type LeaseKind = "http" | "tunnel";

interface ActiveState {
  http: number;
  tunnel: number;
}

interface DailyUsageRow {
  bytes_used: number;
}

interface RateStateRow {
  tokens: number;
  updated_at: number;
}

interface PlannedRate {
  key: string;
  tokens: number;
  updatedAt: number;
}

export interface QuotaLease {
  chargeBytes: (bytes: number) => Promise<void>;
  release: () => Promise<void>;
}

const exceeded = (message: string) =>
  failure("quota_exceeded", "quota", message, 429, true);

const dayAt = (now: number): string => new Date(now).toISOString().slice(0, 10);

const concurrencyLimit = (quota: ExecutionQuotaV1, kind: LeaseKind): number =>
  kind === "http" ? quota.concurrentHttp : quota.concurrentTunnels;

const activeFor = (state: ActiveState, kind: LeaseKind): number => state[kind];

export class QuotaCoordinator {
  readonly #activeByToken = new Map<string, ActiveState>();
  readonly #database: DatabaseClient;
  readonly #now: () => number;
  readonly #instanceActive: ActiveState = { http: 0, tunnel: 0 };
  #tail: Promise<void> = Promise.resolve();

  constructor(database: DatabaseClient, now: () => number = Date.now) {
    this.#database = database;
    this.#now = now;
  }

  async acquire(
    credential: ExecutionCredential,
    kind: LeaseKind,
    initialBytes = 0,
  ): Promise<QuotaLease> {
    return this.#exclusive(async () => {
      this.#assertBytes(initialBytes);
      const tokenActive = this.#activeByToken.get(credential.id) ?? {
        http: 0,
        tunnel: 0,
      };
      if (
        activeFor(tokenActive, kind) >= concurrencyLimit(credential.quota, kind)
      )
        throw exceeded(`Execution token ${kind} concurrency is exhausted`);
      if (
        activeFor(this.#instanceActive, kind) >=
        concurrencyLimit(INSTANCE_QUOTA, kind)
      )
        throw exceeded(`Instance ${kind} concurrency is exhausted`);

      const now = this.#now();
      const tokenRate = await this.#planRate(
        `token:${credential.id}`,
        credential.quota,
        now,
      );
      const instanceRate = await this.#planRate(
        "instance",
        INSTANCE_QUOTA,
        now,
      );
      const byteOperations = await this.#planByteCharge(
        credential,
        initialBytes,
        now,
      );
      await this.#database.transaction([
        this.#rateOperation(tokenRate),
        this.#rateOperation(instanceRate),
        ...byteOperations,
      ]);

      tokenActive[kind] += 1;
      this.#instanceActive[kind] += 1;
      this.#activeByToken.set(credential.id, tokenActive);
      let released = false;
      return {
        chargeBytes: async (bytes) => {
          if (released)
            throw new Error("Quota lease has already been released");
          await this.#exclusive(async () => {
            this.#assertBytes(bytes);
            if (bytes === 0) return;
            const operations = await this.#planByteCharge(
              credential,
              bytes,
              this.#now(),
            );
            await this.#database.transaction(operations);
          });
        },
        release: async () => {
          if (released) return;
          await this.#exclusive(() => {
            if (released) return;
            released = true;
            tokenActive[kind] = Math.max(0, tokenActive[kind] - 1);
            this.#instanceActive[kind] = Math.max(
              0,
              this.#instanceActive[kind] - 1,
            );
            if (tokenActive.http === 0 && tokenActive.tunnel === 0)
              this.#activeByToken.delete(credential.id);
          });
        },
      };
    });
  }

  async #planRate(
    key: string,
    quota: ExecutionQuotaV1,
    now: number,
  ): Promise<PlannedRate> {
    const row = await this.#database.get<RateStateRow>(
      "SELECT tokens, updated_at FROM quota_rate_state WHERE quota_key = ?",
      [key],
    );
    const elapsed = Math.max(0, now - (row?.updated_at ?? now));
    const available = Math.min(
      quota.burst,
      (row?.tokens ?? quota.burst) +
        elapsed * (quota.requestsPerMinute / 60_000),
    );
    if (available < 1) throw exceeded("Request rate limit is exhausted");
    return { key, tokens: available - 1, updatedAt: now };
  }

  #rateOperation(rate: PlannedRate): SqlOperation {
    return {
      kind: "run",
      parameters: [rate.key, rate.tokens, rate.updatedAt],
      sql: `INSERT INTO quota_rate_state(quota_key, tokens, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(quota_key) DO UPDATE SET
          tokens = excluded.tokens, updated_at = excluded.updated_at`,
    };
  }

  async #planByteCharge(
    credential: ExecutionCredential,
    bytes: number,
    now: number,
  ): Promise<SqlOperation[]> {
    const day = dayAt(now);
    const tokenUsed = await this.#readDaily(day, credential.id);
    const instanceUsed = await this.#readDaily(day, INSTANCE_KEY);
    if (tokenUsed + bytes > credential.quota.bytesPerDay)
      throw exceeded("Execution token daily byte quota is exhausted");
    if (instanceUsed + bytes > INSTANCE_QUOTA.bytesPerDay)
      throw exceeded("Instance daily byte quota is exhausted");
    const updatedAt = new Date(now).toISOString();
    return [
      this.#dailyOperation(day, credential.id, tokenUsed + bytes, updatedAt),
      this.#dailyOperation(day, INSTANCE_KEY, instanceUsed + bytes, updatedAt),
    ];
  }

  async #readDaily(day: string, tokenId: string): Promise<number> {
    const row = await this.#database.get<DailyUsageRow>(
      "SELECT bytes_used FROM quota_daily_usage WHERE day = ? AND token_id = ?",
      [day, tokenId],
    );
    return row?.bytes_used ?? 0;
  }

  #dailyOperation(
    day: string,
    tokenId: string,
    bytes: number,
    updatedAt: string,
  ): SqlOperation {
    return {
      kind: "run",
      parameters: [day, tokenId, bytes, updatedAt],
      sql: `INSERT INTO quota_daily_usage(day, token_id, bytes_used, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(day, token_id) DO UPDATE SET
          bytes_used = excluded.bytes_used, updated_at = excluded.updated_at`,
    };
  }

  #assertBytes(bytes: number): void {
    if (!Number.isSafeInteger(bytes) || bytes < 0)
      throw new TypeError("Quota byte charge must be a non-negative integer");
  }

  async #exclusive<Value>(work: () => Value | Promise<Value>): Promise<Value> {
    const previous = this.#tail;
    let release = (): void => undefined;
    this.#tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await work();
    } finally {
      release();
    }
  }
}
