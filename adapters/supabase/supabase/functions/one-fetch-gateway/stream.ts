import { ONE_FETCH_LIMITS_V1 } from "@one-fetch/protocol";
import { IncrementalSha256 } from "@one-fetch/core";

export type StreamFailure = "response_too_large" | "stream_error" | "cancelled";

export function background(promise: Promise<unknown>): void {
  const runtime = (
    globalThis as typeof globalThis & {
      EdgeRuntime?: { waitUntil(value: Promise<unknown>): void };
    }
  ).EdgeRuntime;
  if (runtime) runtime.waitUntil(promise);
  else void promise.catch(() => undefined);
}

export function monitoredBody(
  source: ReadableStream<Uint8Array>,
  controller: AbortController,
  onFinalize: (
    bytes: number,
    complete: boolean,
    bodySha256?: string,
    failure?: StreamFailure,
  ) => Promise<void>,
): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  const hash = new IncrementalSha256();
  let transferred = 0;
  let finalized = false;
  let abortListener: (() => void) | undefined;
  const finish = (complete: boolean, failure?: StreamFailure) => {
    if (finalized) return;
    finalized = true;
    if (abortListener)
      controller.signal.removeEventListener("abort", abortListener);
    const bodySha256 = complete ? hash.digestHex() : undefined;
    background(
      Promise.resolve().then(() =>
        onFinalize(transferred, complete, bodySha256, failure),
      ),
    );
  };
  const cancelUpstream = (reason: unknown) => {
    // A source's asynchronous cancellation must not hold downstream error/Stop.
    background(reader.cancel(reason).catch(() => undefined));
  };
  return new ReadableStream<Uint8Array>({
    start(streamController) {
      abortListener = () => {
        if (finalized) return;
        finish(false, "cancelled");
        streamController.error(controller.signal.reason);
        cancelUpstream(controller.signal.reason);
      };
      if (controller.signal.aborted) abortListener();
      else
        controller.signal.addEventListener("abort", abortListener, {
          once: true,
        });
    },
    async pull(streamController) {
      if (finalized) return;
      try {
        const result = await reader.read();
        if (finalized) return;
        if (result.done) {
          finish(true);
          streamController.close();
          return;
        }
        transferred += result.value.byteLength;
        if (transferred > ONE_FETCH_LIMITS_V1.responseBodyBytes) {
          const error = new RangeError("response_too_large");
          finish(false, "response_too_large");
          streamController.error(error);
          controller.abort(error);
          cancelUpstream(error);
          return;
        }
        hash.update(result.value);
        streamController.enqueue(result.value);
      } catch (error) {
        if (finalized) return;
        finish(false, "stream_error");
        streamController.error(error);
      }
    },
    cancel(reason) {
      if (finalized) return;
      finish(false, "cancelled");
      controller.abort(reason);
      cancelUpstream(reason);
    },
  });
}
