import { ONE_FETCH_LIMITS_V1 } from "@one-fetch/protocol";

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
  onFinalize: (bytes: number, complete: boolean) => Promise<void>,
): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  let transferred = 0;
  let finalized = false;
  const finish = (complete: boolean) => {
    if (finalized) return;
    finalized = true;
    background(onFinalize(transferred, complete));
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
          await reader.cancel("response_too_large");
          controller.abort("response_too_large");
          finish(false);
          streamController.error(new RangeError("response_too_large"));
          return;
        }
        streamController.enqueue(result.value);
      } catch (error) {
        finish(false);
        streamController.error(error);
      }
    },
    async cancel(reason) {
      controller.abort(reason);
      await reader.cancel(reason);
      finish(false);
    },
  });
}
