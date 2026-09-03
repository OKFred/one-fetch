import type { SupabaseEnvironment } from "./env.ts";

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

export interface Database {
  rpc<T>(name: string, parameters?: Record<string, unknown>): Promise<T>;
}

interface PostgrestErrorBody {
  code?: string;
  message?: string;
  details?: string;
  hint?: string;
}

export function createDatabase(environment: SupabaseEnvironment): Database {
  return {
    async rpc<T>(
      name: string,
      parameters: Record<string, unknown> = {},
    ): Promise<T> {
      if (!/^of_[a-z0-9_]+$/u.test(name))
        throw new Error(`Invalid RPC name: ${name}`);
      const response = await fetch(
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
        },
      );
      if (!response.ok) {
        let body: PostgrestErrorBody = {};
        try {
          body = (await response.json()) as PostgrestErrorBody;
        } catch {
          // The platform can return non-JSON failures. Never include its body because it may contain details.
        }
        throw new DatabaseError(
          body.message ?? `Database RPC ${name} failed`,
          response.status,
          body.code,
        );
      }
      return (await response.json()) as T;
    },
  };
}
