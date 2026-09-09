import { Worker } from "node:worker_threads";

import { DATABASE_SCHEMA_VERSION } from "./database-schema.js";
import type {
  DatabaseRequestWithoutId,
  DatabaseResponse,
  DatabaseWorkerMessage,
  RunResult,
  SqlOperation,
  SqlValue,
} from "./database-protocol.js";

interface PendingRequest {
  reject: (reason: Error) => void;
  resolve: (value: unknown) => void;
}

export class DatabaseConditionalWriteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DatabaseConditionalWriteError";
  }
}

export class DatabaseClient {
  readonly fatal: Promise<Error>;
  readonly #pending = new Map<number, PendingRequest>();
  readonly #startup: Promise<void>;
  readonly #worker: Worker;
  readonly #rejectStartup: (reason: Error) => void;
  readonly #resolveFatal: (error: Error) => void;
  readonly #resolveStartup: () => void;
  #closed = false;
  #closing: Promise<void> | undefined;
  #expectedExit = false;
  #fatalTerminationStarted = false;
  #nextId = 1;
  #startupReady = false;
  #startupSettled = false;
  #terminalError: Error | undefined;

  constructor(databasePath: string, workerEntry?: URL) {
    let resolveFatal!: (error: Error) => void;
    let rejectStartup!: (reason: Error) => void;
    let resolveStartup!: () => void;
    this.#startup = new Promise<void>((resolve, reject) => {
      rejectStartup = reject;
      resolveStartup = resolve;
    });
    this.#rejectStartup = rejectStartup;
    this.#resolveStartup = resolveStartup;
    this.fatal = new Promise<Error>((resolve) => {
      resolveFatal = resolve;
    });
    this.#resolveFatal = resolveFatal;
    void this.#startup.catch(() => undefined);

    const workerFile = import.meta.url.endsWith(".ts")
      ? "../dist/database-worker.js"
      : "./database-worker.js";
    this.#worker = new Worker(
      workerEntry ?? new URL(workerFile, import.meta.url),
      {
        workerData: { databasePath },
      },
    );
    this.#worker.on("message", (message: DatabaseWorkerMessage) =>
      this.#handleMessage(message),
    );
    this.#worker.on("error", (error: unknown) => {
      const workerError =
        error instanceof Error
          ? error
          : new Error("Unknown database worker error");
      if (this.#expectedExit) this.#rejectAll(this.#closedError());
      else this.#markFatal(workerError);
    });
    this.#worker.on("exit", (code) => {
      if (this.#expectedExit) {
        this.#rejectAll(this.#closedError());
        return;
      }
      this.#markFatal(
        new Error(`Database worker exited unexpectedly with code ${code}`),
      );
    });
  }

  async ready(): Promise<void> {
    this.#throwIfUnavailable();
    await this.#startup;
    this.#throwIfUnavailable();
  }

  async close(): Promise<void> {
    this.#closing ??= this.#closeOnce();
    await this.#closing;
  }

  async exec(sql: string): Promise<void> {
    await this.#request({ kind: "exec", sql });
  }

  async run(sql: string, parameters: SqlValue[] = []): Promise<RunResult> {
    return (await this.#request({
      kind: "operation",
      operation: {
        kind: "run",
        sql,
        parameters,
      },
    })) as RunResult;
  }

  async get<T extends object>(
    sql: string,
    parameters: SqlValue[] = [],
  ): Promise<T | undefined> {
    return (await this.#request({
      kind: "operation",
      operation: { kind: "get", sql, parameters },
    })) as T | undefined;
  }

  async all<T extends object>(
    sql: string,
    parameters: SqlValue[] = [],
  ): Promise<T[]> {
    return (await this.#request({
      kind: "operation",
      operation: { kind: "all", sql, parameters },
    })) as T[];
  }

  async transaction(operations: SqlOperation[]): Promise<unknown[]> {
    return (await this.#request({
      kind: "transaction",
      operations,
    })) as unknown[];
  }

  async integrityCheck(): Promise<void> {
    const result = (await this.#request({ kind: "integrity" })) as {
      integrity_check?: unknown;
    };
    if (result.integrity_check !== "ok")
      throw new Error("Database integrity check failed");
  }

  async #closeOnce(): Promise<void> {
    this.#closed = true;
    this.#expectedExit = true;
    const closedError = this.#closedError();

    if (!this.#startupSettled) {
      this.#startupSettled = true;
      this.#rejectStartup(closedError);
    }
    if (this.#startupReady && !this.#terminalError) {
      try {
        await this.#send({ kind: "close" }, true);
      } catch {
        // A concurrent worker exit is still a completed close.
      }
    }
    this.#rejectAll(closedError);
    try {
      await this.#worker.terminate();
    } catch {
      // The worker may already have terminated after acknowledging close.
    }
  }

  async #request(request: DatabaseRequestWithoutId): Promise<unknown> {
    await this.ready();
    return this.#send(request);
  }

  #send(
    request: DatabaseRequestWithoutId,
    allowClosed = false,
  ): Promise<unknown> {
    if (this.#terminalError) return Promise.reject(this.#terminalError);
    if (this.#closed && !allowClosed)
      return Promise.reject(this.#closedError());

    const id = this.#nextId;
    this.#nextId += 1;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { reject, resolve });
      try {
        this.#worker.postMessage({ ...request, id });
      } catch (error) {
        const workerError =
          error instanceof Error
            ? error
            : new Error("Unable to contact database worker");
        if (this.#expectedExit) {
          this.#pending.delete(id);
          reject(this.#closedError());
        } else {
          this.#markFatal(workerError);
        }
      }
    });
  }

  #handleMessage(message: DatabaseWorkerMessage): void {
    if ("kind" in message) {
      if (message.kind === "startup-fatal") {
        this.#markFatal(new Error(message.error));
        return;
      }
      if (message.schemaVersion !== DATABASE_SCHEMA_VERSION) {
        this.#markFatal(
          new Error(
            `Database worker reported schema ${message.schemaVersion}; expected ${DATABASE_SCHEMA_VERSION}`,
          ),
        );
        return;
      }
      if (!this.#startupSettled) {
        this.#startupReady = true;
        this.#startupSettled = true;
        this.#resolveStartup();
      }
      return;
    }
    this.#resolve(message);
  }

  #resolve(response: DatabaseResponse): void {
    const pending = this.#pending.get(response.id);
    if (!pending) return;
    this.#pending.delete(response.id);
    if (response.ok) pending.resolve(response.result);
    else {
      pending.reject(
        response.code === "conditional_write_failed"
          ? new DatabaseConditionalWriteError(response.error)
          : new Error(response.error),
      );
    }
  }

  #rejectAll(error: Error): void {
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }

  #markFatal(error: Error): void {
    const firstFailure = !this.#terminalError;
    this.#terminalError ??= error;
    if (!this.#startupSettled) {
      this.#startupSettled = true;
      this.#rejectStartup(this.#terminalError);
    }
    this.#rejectAll(this.#terminalError);
    if (firstFailure) {
      this.#resolveFatal(this.#terminalError);
      this.#terminateAfterFatal();
    }
  }

  #terminateAfterFatal(): void {
    if (this.#fatalTerminationStarted) return;
    this.#fatalTerminationStarted = true;
    void this.#worker.terminate().catch(() => undefined);
  }

  #throwIfUnavailable(): void {
    if (this.#terminalError) throw this.#terminalError;
    if (this.#closed) throw this.#closedError();
  }

  #closedError(): Error {
    return new Error("Database client is closed");
  }
}
