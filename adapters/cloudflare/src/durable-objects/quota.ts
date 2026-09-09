import { DurableObject } from "cloudflare:workers";

import type {
  QuotaAcquireInput,
  QuotaAcquireResult,
  QuotaSnapshot,
  Transport,
} from "../types";

interface CountRow {
  [key: string]: SqlStorageValue;
  count: number;
}

interface BytesRow {
  [key: string]: SqlStorageValue;
  bytes: number;
}

export class QuotaDurableObject extends DurableObject<CloudflareControlEnv> {
  constructor(ctx: DurableObjectState, env: CloudflareControlEnv) {
    super(ctx, env);
    void ctx.blockConcurrencyWhile(() => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS quota_buckets (
          kind TEXT NOT NULL,
          bucket INTEGER NOT NULL,
          count INTEGER NOT NULL,
          bytes INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (kind, bucket)
        );
        CREATE TABLE IF NOT EXISTS active_leases (
          request_id TEXT PRIMARY KEY,
          transport TEXT NOT NULL,
          request_bytes INTEGER NOT NULL,
          expires_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS active_leases_expiry_idx ON active_leases(expires_at);
      `);
      return Promise.resolve();
    });
  }

  async acquire(input: QuotaAcquireInput): Promise<QuotaAcquireResult> {
    this.expireLeases(input.now);
    const existing = this.ctx.storage.sql
      .exec<{
        expires_at: number;
      }>(
        "SELECT expires_at FROM active_leases WHERE request_id = ?",
        input.requestId,
      )
      .toArray()[0];
    if (existing)
      return {
        allowed: false,
        code: "concurrency_limited",
        retryAfterMs: Math.max(1, existing.expires_at - input.now),
      };

    const minute = Math.floor(input.now / 60_000);
    const second = Math.floor(input.now / 1_000);
    const day = Math.floor(input.now / 86_400_000);
    const minuteCount = this.count("minute", minute);
    if (minuteCount >= input.limits.requestsPerMinute) {
      return {
        allowed: false,
        code: "rate_limited",
        retryAfterMs: (minute + 1) * 60_000 - input.now,
      };
    }
    const secondCount = this.count("second", second);
    if (secondCount >= input.limits.burstPerSecond) {
      return {
        allowed: false,
        code: "rate_limited",
        retryAfterMs: (second + 1) * 1_000 - input.now,
      };
    }

    const active = this.activeCount(input.transport);
    const concurrencyLimit = isTunnel(input.transport)
      ? input.limits.concurrentTunnels
      : input.limits.concurrentHttp;
    if (active >= concurrencyLimit)
      return {
        allowed: false,
        code: "concurrency_limited",
        retryAfterMs: 1_000,
      };

    const dailyBytes = this.bytes("day", day);
    if (dailyBytes + input.requestBytes > input.limits.bytesPerDay) {
      return {
        allowed: false,
        code: "quota_exceeded",
        retryAfterMs: (day + 1) * 86_400_000 - input.now,
      };
    }

    const leaseExpiresAt = input.now + input.leaseTtlMs;
    this.ctx.storage.sql.exec(
      `INSERT INTO quota_buckets (kind, bucket, count, bytes) VALUES ('minute', ?, 1, 0)
       ON CONFLICT(kind, bucket) DO UPDATE SET count = count + 1`,
      minute,
    );
    this.ctx.storage.sql.exec(
      `INSERT INTO quota_buckets (kind, bucket, count, bytes) VALUES ('second', ?, 1, 0)
       ON CONFLICT(kind, bucket) DO UPDATE SET count = count + 1`,
      second,
    );
    this.ctx.storage.sql.exec(
      `INSERT INTO quota_buckets (kind, bucket, count, bytes) VALUES ('day', ?, 0, ?)
       ON CONFLICT(kind, bucket) DO UPDATE SET bytes = bytes + excluded.bytes`,
      day,
      input.requestBytes,
    );
    this.ctx.storage.sql.exec(
      "INSERT INTO active_leases (request_id, transport, request_bytes, expires_at) VALUES (?, ?, ?, ?)",
      input.requestId,
      input.transport,
      input.requestBytes,
      leaseExpiresAt,
    );
    await this.scheduleNextAlarm();
    return { allowed: true, leaseExpiresAt };
  }

  async release(
    requestId: string,
    responseBytes: number,
    requestBytes = 0,
    now = Date.now(),
  ): Promise<void> {
    const lease = this.ctx.storage.sql
      .exec<{
        request_bytes: number;
      }>(
        "SELECT request_bytes FROM active_leases WHERE request_id = ?",
        requestId,
      )
      .toArray()[0];
    this.ctx.storage.sql.exec(
      "DELETE FROM active_leases WHERE request_id = ?",
      requestId,
    );
    const day = Math.floor(now / 86_400_000);
    this.ctx.storage.sql.exec(
      `INSERT INTO quota_buckets (kind, bucket, count, bytes) VALUES ('day', ?, 0, ?)
       ON CONFLICT(kind, bucket) DO UPDATE SET bytes = bytes + excluded.bytes`,
      day,
      Math.max(0, responseBytes) +
        Math.max(0, requestBytes - (lease?.request_bytes ?? 0)),
    );
    this.deleteOldBuckets(now);
    await this.scheduleNextAlarm();
  }

  async renew(
    requestId: string,
    now: number,
    leaseTtlMs: number,
  ): Promise<boolean> {
    this.expireLeases(now);
    const result = this.ctx.storage.sql.exec(
      "UPDATE active_leases SET expires_at = ? WHERE request_id = ?",
      now + leaseTtlMs,
      requestId,
    );
    const renewed = result.rowsWritten > 0;
    if (renewed) await this.scheduleNextAlarm();
    return renewed;
  }

  snapshot(now = Date.now()): QuotaSnapshot {
    this.expireLeases(now);
    return {
      minuteRequests: this.count("minute", Math.floor(now / 60_000)),
      secondRequests: this.count("second", Math.floor(now / 1_000)),
      activeHttp: this.activeCount("http"),
      activeTunnels: this.activeCount("websocket"),
      dailyBytes: this.bytes("day", Math.floor(now / 86_400_000)),
    };
  }

  override async alarm(): Promise<void> {
    this.expireLeases(Date.now());
    await this.scheduleNextAlarm();
  }

  private count(kind: string, bucket: number): number {
    return (
      this.ctx.storage.sql
        .exec<CountRow>(
          "SELECT count FROM quota_buckets WHERE kind = ? AND bucket = ?",
          kind,
          bucket,
        )
        .toArray()[0]?.count ?? 0
    );
  }

  private bytes(kind: string, bucket: number): number {
    return (
      this.ctx.storage.sql
        .exec<BytesRow>(
          "SELECT bytes FROM quota_buckets WHERE kind = ? AND bucket = ?",
          kind,
          bucket,
        )
        .toArray()[0]?.bytes ?? 0
    );
  }

  private activeCount(transport: Transport): number {
    const predicate = isTunnel(transport)
      ? "transport != 'http'"
      : "transport = 'http'";
    return this.ctx.storage.sql
      .exec<CountRow>(
        `SELECT COUNT(*) AS count FROM active_leases WHERE ${predicate}`,
      )
      .one().count;
  }

  private expireLeases(now: number): void {
    this.ctx.storage.sql.exec(
      "DELETE FROM active_leases WHERE expires_at <= ?",
      now,
    );
  }

  private deleteOldBuckets(now: number): void {
    this.ctx.storage.sql.exec(
      `DELETE FROM quota_buckets WHERE
       (kind = 'second' AND bucket < ?) OR
       (kind = 'minute' AND bucket < ?) OR
       (kind = 'day' AND bucket < ?)`,
      Math.floor(now / 1_000) - 120,
      Math.floor(now / 60_000) - 120,
      Math.floor(now / 86_400_000) - 2,
    );
  }

  private async scheduleNextAlarm(): Promise<void> {
    const next = this.ctx.storage.sql
      .exec<{
        expires_at: number;
      }>("SELECT MIN(expires_at) AS expires_at FROM active_leases")
      .toArray()[0];
    if (next?.expires_at) await this.ctx.storage.setAlarm(next.expires_at);
    else await this.ctx.storage.deleteAlarm();
  }
}

function isTunnel(transport: Transport): boolean {
  return transport !== "http";
}
