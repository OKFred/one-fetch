export type SqlValue = string | number | bigint | null | Uint8Array;

export interface SqlOperation {
  kind: "run" | "get" | "all";
  sql: string;
  parameters?: SqlValue[];
}

export type DatabaseRequest =
  | { id: number; kind: "close" }
  | { id: number; kind: "exec"; sql: string }
  | { id: number; kind: "integrity" }
  | { id: number; kind: "operation"; operation: SqlOperation }
  | { id: number; kind: "transaction"; operations: SqlOperation[] };

export type DatabaseRequestWithoutId = DatabaseRequest extends infer Request
  ? Request extends { id: number }
    ? Omit<Request, "id">
    : never
  : never;

export interface RunResult {
  changes: number;
  lastInsertRowid: bigint;
}

export type SqlRow = Record<string, SqlValue>;
export type SqlResult = RunResult | SqlRow | SqlRow[] | undefined;

export type DatabaseResponse =
  | { id: number; ok: true; result?: SqlResult | SqlResult[] }
  | { id: number; ok: false; error: string };
