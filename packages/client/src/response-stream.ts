import type { GatewayProgressPhase } from "./gateway.js";

export function composeAbortSignal(
  parent: AbortSignal | undefined,
  timeoutMs: number,
): {
  signal: AbortSignal;
  cancel: (reason?: unknown) => void;
  cleanup: () => void;
} {
  const controller = new AbortController();
  const cleanup = (): void => {
    globalThis.clearTimeout(timer);
    parent?.removeEventListener("abort", abortFromParent);
  };
  const cancel = (reason?: unknown): void => {
    if (controller.signal.aborted) return;
    controller.abort(
      reason ?? new DOMException("Request cancelled", "AbortError"),
    );
  };
  const abortFromParent = (): void => cancel(parent?.reason);
  controller.signal.addEventListener("abort", cleanup, { once: true });
  parent?.addEventListener("abort", abortFromParent, { once: true });
  const timer = globalThis.setTimeout(
    () =>
      cancel(
        new DOMException(`Request exceeded ${timeoutMs} ms`, "TimeoutError"),
      ),
    timeoutMs,
  );
  if (parent?.aborted === true) abortFromParent();
  return { signal: controller.signal, cancel, cleanup };
}

function responseLength(response: Response): number | undefined {
  const value = response.headers.get("Content-Length");
  if (value === null || !/^(?:0|[1-9][0-9]*)$/u.test(value)) return undefined;
  const length = Number(value);
  return Number.isSafeInteger(length) ? length : undefined;
}

export function trackResponseBody(
  response: Response,
  abort: ReturnType<typeof composeAbortSignal>,
  progress: (
    phase: GatewayProgressPhase,
    loadedBytes?: number,
    totalBytes?: number,
  ) => void,
): Response {
  const totalBytes = responseLength(response);
  progress("downloading", 0, totalBytes);
  if (response.body === null) {
    abort.cleanup();
    progress("complete", 0, totalBytes);
    return response;
  }

  const reader = response.body.getReader();
  let loadedBytes = 0;
  let finished = false;
  let abortListener: (() => void) | undefined;
  const finish = (): void => {
    if (finished) return;
    finished = true;
    if (abortListener !== undefined)
      abort.signal.removeEventListener("abort", abortListener);
    abort.cleanup();
  };
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      abortListener = () => {
        if (finished) return;
        finish();
        void reader.cancel(abort.signal.reason).catch(() => undefined);
        controller.error(abort.signal.reason);
      };
      if (abort.signal.aborted) abortListener();
      else
        abort.signal.addEventListener("abort", abortListener, { once: true });
    },
    async pull(controller) {
      if (finished) return;
      try {
        const item = await reader.read();
        if (finished) return;
        if (item.done) {
          finish();
          progress("complete", loadedBytes, totalBytes);
          controller.close();
          return;
        }
        loadedBytes += item.value.byteLength;
        progress("downloading", loadedBytes, totalBytes);
        controller.enqueue(item.value);
      } catch (error) {
        if (!finished) {
          finish();
          controller.error(error);
        }
      }
    },
    async cancel(reason) {
      if (finished) return;
      finish();
      abort.cancel(reason);
      await reader.cancel(reason);
    },
  });
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
