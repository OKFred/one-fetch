import { Worker } from "node:worker_threads";

import type {
  DatabaseRequestWithoutId,
  DatabaseResponse,
  RunResult,
  SqlOperation,
  SqlValue,
} from "./database-protocol.js";

interface PendingRequest {
  reject: (reason: Error) => void;
  resolve: (value: unknown) => void;
}

export class DatabaseClient {
  readonly #pending = new Map<number, PendingRequest>();
  readonly #worker: Worker;
  #nextId = 1;

  constructor(databasePath: string) {
    const workerFile = import.meta.url.endsWith(".ts")
      ? "../dist/database-worker.js"
      : "./database-worker.js";
    this.#worker = new Worker(new URL(workerFile, import.meta.url), {
      workerData: { databasePath },
    });
    this.#worker.on("message", (response: DatabaseResponse) =>
      this.#resolve(response),
    );
    this.#worker.on("error", (error: unknown) =>
      this.#rejectAll(
        error instanceof Error
          ? error
          : new Error("Unknown database worker error"),
      ),
    );
    this.#worker.on("exit", (code) => {
      if (code !== 0)
        this.#rejectAll(new Error(`Database worker exited with code ${code}`));
    });
  }

  async ready(): Promise<void> {
    await this.integrityCheck();
  }

  async close(): Promise<void> {
    await this.#send({ kind: "close" });
    await this.#worker.terminate();
  }

  async exec(sql: string): Promise<void> {
    await this.#send({ kind: "exec", sql });
  }

  async run(sql: string, parameters: SqlValue[] = []): Promise<RunResult> {
    return (await this.#operation({
      kind: "run",
      sql,
      parameters,
    })) as RunResult;
  }

  async get<T extends object>(
    sql: string,
    parameters: SqlValue[] = [],
  ): Promise<T | undefined> {
    return (await this.#operation({ kind: "get", sql, parameters })) as
      | T
      | undefined;
  }

  async all<T extends object>(
    sql: string,
    parameters: SqlValue[] = [],
  ): Promise<T[]> {
    return (await this.#operation({ kind: "all", sql, parameters })) as T[];
  }

  async transaction(operations: SqlOperation[]): Promise<unknown[]> {
    return (await this.#send({ kind: "transaction", operations })) as unknown[];
  }

  async integrityCheck(): Promise<void> {
    const result = (await this.#send({ kind: "integrity" })) as {
      integrity_check?: unknown;
    };
    if (result.integrity_check !== "ok")
      throw new Error("Database integrity check failed");
  }

  async #operation(operation: SqlOperation): Promise<unknown> {
    return this.#send({ kind: "operation", operation });
  }

  async #send(request: DatabaseRequestWithoutId): Promise<unknown> {
    const id = this.#nextId;
    this.#nextId += 1;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { reject, resolve });
      this.#worker.postMessage({ ...request, id });
    });
  }

  #resolve(response: DatabaseResponse): void {
    const pending = this.#pending.get(response.id);
    if (!pending) return;
    this.#pending.delete(response.id);
    if (response.ok) pending.resolve(response.result);
    else pending.reject(new Error(response.error));
  }

  #rejectAll(error: Error): void {
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }
}
