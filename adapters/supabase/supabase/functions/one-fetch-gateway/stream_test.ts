import { ONE_FETCH_LIMITS_V1 } from "@one-fetch/protocol";

import { monitoredBody, type StreamFailure } from "./stream.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

interface FinalState {
  bytes: number;
  complete: boolean;
  bodySha256?: string;
  failure?: StreamFailure;
}

function monitor(source: ReadableStream<Uint8Array>) {
  let resolve!: (value: FinalState) => void;
  const finalized = new Promise<FinalState>((done) => {
    resolve = done;
  });
  const body = monitoredBody(
    source,
    new AbortController(),
    (bytes, complete, bodySha256, failure) => {
      resolve({
        bytes,
        complete,
        ...(bodySha256 ? { bodySha256 } : {}),
        ...(failure ? { failure } : {}),
      });
      return Promise.resolve();
    },
  );
  return { body, finalized };
}

Deno.test(
  "Response streaming records an incremental SHA-256 digest",
  async () => {
    const encoder = new TextEncoder();
    const { body, finalized } = monitor(
      new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode("a"));
          controller.enqueue(encoder.encode("bc"));
          controller.close();
        },
      }),
    );
    assert(
      (await new Response(body).text()) === "abc",
      "body changed in transit",
    );
    const result = await finalized;
    assert(result.complete, "complete stream was marked partial");
    assert(result.bytes === 3, "stream byte count is incorrect");
    assert(
      result.bodySha256 ===
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
      "stream digest is incorrect",
    );
  },
);

Deno.test(
  "Unknown-length responses report the 20 MiB limit distinctly",
  async () => {
    const oversized = new Uint8Array(ONE_FETCH_LIMITS_V1.responseBodyBytes + 1);
    const { body, finalized } = monitor(
      new ReadableStream({
        start(controller) {
          controller.enqueue(oversized);
        },
      }),
    );
    let rejected = false;
    try {
      await new Response(body).arrayBuffer();
    } catch {
      rejected = true;
    }
    assert(rejected, "oversized response was returned as complete");
    const result = await finalized;
    assert(!result.complete, "oversized response was marked complete");
    assert(
      result.failure === "response_too_large",
      "response limit failure was not preserved",
    );
  },
);
