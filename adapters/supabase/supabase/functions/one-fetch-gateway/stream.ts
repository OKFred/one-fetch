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
  const finish = (complete: boolean, failure?: StreamFailure) => {
    if (finalized) return;
    finalized = true;
    const bodySha256 = complete ? hash.digestHex() : undefined;
    background(onFinalize(transferred, complete, bodySha256, failure));
  };
  return new ReadableStream<Uint8Array>({
    async pull(streamController) {
      try {
        const result = await reader.read();
        if (result.done) {
          finish(true);
          streamController.close();
          return;
        }
        transferred += result.value.byteLength;
        if (transferred > ONE_FETCH_LIMITS_V1.responseBodyBytes) {
          controller.abort(
            new RangeError("Target response exceeded the 20 MiB limit"),
          );
          finish(false, "response_too_large");
          await reader.cancel("response_too_large").catch(() => undefined);
          streamController.error(new RangeError("response_too_large"));
          return;
        }
        hash.update(result.value);
        streamController.enqueue(result.value);
      } catch (error) {
        finish(false, "stream_error");
        streamController.error(error);
      }
    },
    async cancel(reason) {
      controller.abort(reason);
      finish(false, "cancelled");
      await reader.cancel(reason);
    },
  });
}
