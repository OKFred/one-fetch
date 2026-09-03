import type { SupabaseEnvironment } from "./env.ts";
import { z } from "zod";

const DATABASE_RPC_TIMEOUT_MS = 15_000;

export class DatabaseError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "DatabaseError";
  }
}

export class StorageContractError extends Error {
  constructor(readonly operation: string) {
    super(`Storage result did not match the contract for ${operation}`);
    this.name = "StorageContractError";
  }
}

export function parseStorageResult<T>(
  operation: string,
  schema: z.ZodType<T>,
  value: unknown,
): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new StorageContractError(operation);
  return result.data;
}

export interface Database {
  rpc<T>(name: string, parameters?: Record<string, unknown>): Promise<T>;
}

interface PostgrestErrorBody {
  code?: string;
  message?: string;
}

function postgrestErrorBody(value: unknown): PostgrestErrorBody {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  return {
    ...(typeof record.code === "string" ? { code: record.code } : {}),
    ...(typeof record.message === "string" ? { message: record.message } : {}),
  };
}

export interface DatabaseTransportOptions {
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}

export function createDatabase(
  environment: SupabaseEnvironment,
  options: DatabaseTransportOptions = {},
): Database {
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DATABASE_RPC_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError("Database timeout must be a positive finite number");
  }
  return {
    async rpc<T>(
      name: string,
      parameters: Record<string, unknown> = {},
    ): Promise<T> {
      if (!/^of_[a-z0-9_]+$/u.test(name)) {
        throw new Error(`Invalid RPC name: ${name}`);
      }
      const controller = new AbortController();
      const timeout = setTimeout(
        () =>
          controller.abort(
            new DOMException("Database timeout", "TimeoutError"),
          ),
        timeoutMs,
      );
      try {
        const response = await fetchImplementation(
          `${environment.supabaseUrl}/rest/v1/rpc/${name}`,
          {
            method: "POST",
            headers: {
              apikey: environment.serviceRoleKey,
              authorization: `Bearer ${environment.serviceRoleKey}`,
              "content-type": "application/json",
              "user-agent": `one-fetch-supabase/${environment.buildVersion}`,
            },
            body: JSON.stringify(parameters),
            signal: controller.signal,
          },
        );
        if (!response.ok) {
          let body: PostgrestErrorBody = {};
          try {
            body = postgrestErrorBody(await response.json());
          } catch {
            if (controller.signal.aborted) {
              throw new DatabaseError(
                `Database RPC ${name} timed out`,
                503,
                "database_timeout",
              );
            }
            // The platform can return non-JSON failures. Never include its body because it may contain details.
          }
          throw new DatabaseError(
            body.message ?? `Database RPC ${name} failed`,
            response.status,
            body.code,
          );
        }
        try {
          return (await response.json()) as T;
        } catch (error) {
          if (controller.signal.aborted) {
            throw new DatabaseError(
              `Database RPC ${name} timed out`,
              503,
              "database_timeout",
            );
          }
          const invalidJson = error instanceof SyntaxError;
          throw new DatabaseError(
            `Database RPC ${name} ${
              invalidJson ? "returned invalid JSON" : "response failed"
            }`,
            503,
            invalidJson ? "database_invalid_json" : "database_transport",
          );
        }
      } catch (error) {
        if (error instanceof DatabaseError) throw error;
        throw new DatabaseError(
          `Database RPC ${name} transport failed`,
          503,
          controller.signal.aborted ? "database_timeout" : "database_transport",
        );
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}
