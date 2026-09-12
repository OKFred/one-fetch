import { ONE_FETCH_LIMITS_V1 } from "@one-fetch/protocol";

import { monitoredBody, type StreamFailure } from "./stream.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function beforeCleanup<T>(operation: Promise<T>): Promise<T | "pending"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<"pending">((resolve) => {
        timer = setTimeout(() => resolve("pending"), 100);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function observe(
  source: ReadableStream<Uint8Array>,
  abort = new AbortController(),
) {
  const records: { complete: boolean; failure?: StreamFailure }[] = [];
  const body = monitoredBody(
    source,
    abort,
    (_bytes, complete, _hash, failure) => {
      records.push({ complete, ...(failure === undefined ? {} : { failure }) });
      return Promise.resolve();
    },
  );
  return { body, abort, records };
}

Deno.test(
  "Oversized response rejects before upstream cancellation settles",
  async () => {
    const cleanup = deferred();
    let cancellations = 0;
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new Uint8Array(ONE_FETCH_LIMITS_V1.responseBodyBytes + 1),
        );
      },
      cancel() {
        cancellations += 1;
        return cleanup.promise;
      },
    });
    const { body, abort, records } = observe(source);
    const outcome = new Response(body).arrayBuffer().then(
      () => "completed",
      (error: unknown) =>
        error instanceof RangeError ? error.message : "wrong-error",
    );
    try {
      assert(
        (await beforeCleanup(outcome)) === "response_too_large",
        "downstream waited for upstream cleanup",
      );
      assert(
        abort.signal.aborted && cancellations === 1,
        "upstream cancellation was not requested exactly once",
      );
      assert(
        records.length === 1 && records[0]?.failure === "response_too_large",
        "limit finalization changed",
      );
      assert(
        records[0]?.complete === false,
        "oversized response was marked complete",
      );
    } finally {
      cleanup.resolve();
      await outcome;
    }
  },
);

for (const errorName of ["AbortError", "TimeoutError"] as const) {
  Deno.test(
    `${errorName} rejects a pending read without waiting for upstream cleanup`,
    async () => {
      const cleanup = deferred();
      let cancellations = 0;
      const { body, abort, records } = observe(
        new ReadableStream<Uint8Array>({
          cancel() {
            cancellations += 1;
            return cleanup.promise;
          },
        }),
      );
      const reason = new DOMException("Synthetic stop", errorName);
      const reader = body.getReader();
      const outcome = reader.read().then(
        () => "completed",
        (error: unknown) => error,
      );
      await Promise.resolve();
      abort.abort(reason);
      try {
        assert(
          (await beforeCleanup(outcome)) === reason,
          "pending read ignored the abort signal",
        );
        assert(
          cancellations === 1,
          "abort did not reach upstream exactly once",
        );
        assert(
          records.length === 1 && records[0]?.complete === false,
          "abort was not finalized exactly once",
        );
      } finally {
        cleanup.resolve();
        await reader.cancel().catch(() => undefined);
        await outcome;
        reader.releaseLock();
      }
    },
  );
}

Deno.test(
  "A pre-aborted response never forwards its buffered chunk",
  async () => {
    const abort = new AbortController();
    const reason = new DOMException("Already cancelled", "AbortError");
    abort.abort(reason);
    let cancellations = 0;
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.close();
      },
      cancel() {
        cancellations += 1;
      },
    });
    const { body, records } = observe(source, abort);
    const result = await new Response(body).arrayBuffer().then(
      () => "completed",
      (error: unknown) => error,
    );
    assert(result === reason, "pre-aborted body was forwarded");
    assert(
      cancellations === 1 && records.length === 1 && !records[0]?.complete,
      "pre-aborted response cleanup changed",
    );
  },
);

Deno.test(
  "Consumer cancellation does not wait for cleanup or finalize a late EOF",
  async () => {
    const cleanup = deferred();
    let cancellations = 0;
    const { body, abort, records } = observe(
      new ReadableStream<Uint8Array>({
        cancel() {
          cancellations += 1;
          return cleanup.promise;
        },
      }),
    );
    const reader = body.getReader();
    const reading = reader.read();
    await Promise.resolve();
    const stopped = reader.cancel("synthetic stop").then(() => "cancelled");
    try {
      assert(
        (await beforeCleanup(stopped)) === "cancelled",
        "consumer cancellation waited for cleanup",
      );
      assert((await reading).done, "cancelled pending read did not end");
      assert(
        abort.signal.aborted && cancellations === 1,
        "consumer cancellation did not abort upstream",
      );
      assert(
        records.length === 1 && records[0]?.failure === "cancelled",
        "late EOF changed the terminal record",
      );
      assert(
        records[0]?.complete === false,
        "cancelled result was marked complete",
      );
    } finally {
      cleanup.resolve();
      await stopped;
      reader.releaseLock();
    }
  },
);

Deno.test(
  "Rejecting upstream cleanup cannot replace the limit error",
  async () => {
    const { body, records } = observe(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            new Uint8Array(ONE_FETCH_LIMITS_V1.responseBodyBytes + 1),
          );
        },
        cancel() {
          return Promise.reject(new Error("Synthetic cleanup failure"));
        },
      }),
    );
    const outcome = await new Response(body).arrayBuffer().then(
      () => "completed",
      (error: unknown) =>
        error instanceof RangeError ? error.message : "wrong-error",
    );
    assert(
      outcome === "response_too_large",
      "cleanup replaced the terminal error",
    );
    assert(
      records.length === 1 && records[0]?.failure === "response_too_large",
      "cleanup changed the terminal record",
    );
  },
);

Deno.test(
  "Abort after successful completion cannot reclassify the response",
  async () => {
    let cancellations = 0;
    const { body, abort, records } = observe(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1]));
          controller.close();
        },
        cancel() {
          cancellations += 1;
        },
      }),
    );
    assert(
      (await new Response(body).arrayBuffer()).byteLength === 1,
      "successful body changed",
    );
    abort.abort(new DOMException("Late cancellation", "AbortError"));
    await Promise.resolve();
    assert(cancellations === 0, "late abort cancelled a completed upstream");
    assert(
      records.length === 1 && records[0]?.complete,
      "late abort changed successful finalization",
    );
  },
);
