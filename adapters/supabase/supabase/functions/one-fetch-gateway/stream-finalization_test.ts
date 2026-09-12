import {
  decodeRequestMetadata,
  decodeResponseMetadata,
  encodeRequestMetadata,
  ExecutionReportV1Schema,
  ONE_FETCH_LIMITS_V1,
  ONE_FETCH_REQUEST_HEADER,
  ONE_FETCH_RESPONSE_HEADER,
} from "@one-fetch/protocol";
import { verifySignedResponseMetadata } from "@one-fetch/core";

import {
  boundPathRequest,
  pathHarness,
  pathToken,
} from "./path-test-support.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function settledBeforeCleanup(operation: Promise<string>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<string>((resolve) => {
        timer = setTimeout(() => resolve("still-pending"), 100);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

for (const mode of ["limit", "cancel", "timeout"] as const) {
  Deno.test(
    `Gateway ${mode} finalizes one incomplete report while source cleanup is pending`,
    async () => {
      const harness = await pathHarness();
      const requestAbort = new AbortController();
      let releaseCleanup!: () => void;
      const cleanup = new Promise<void>((resolve) => {
        releaseCleanup = resolve;
      });
      let cancellations = 0;
      let sourceController!: ReadableStreamDefaultController<Uint8Array>;
      let upstreamSignal: AbortSignal | null | undefined;
      const originalFetch = globalThis.fetch;
      const original = boundPathRequest(
        harness.environment.gatewayBaseUrl,
        "/echo",
        "/echo",
      );
      const headers = new Headers(original.headers);
      const metadata = decodeRequestMetadata(
        headers.get(ONE_FETCH_REQUEST_HEADER) ?? "",
      );
      // Allow authentication/signing to finish on busy runners before body timeout.
      metadata.fetchOptions.timeoutMs = mode === "timeout" ? 3_000 : 60_000;
      headers.set(ONE_FETCH_REQUEST_HEADER, encodeRequestMetadata(metadata));
      const request = new Request(original, {
        headers,
        signal: requestAbort.signal,
      });
      const source = new ReadableStream<Uint8Array>({
        start(controller) {
          sourceController = controller;
          controller.enqueue(
            new Uint8Array(
              mode === "limit" ? ONE_FETCH_LIMITS_V1.responseBodyBytes + 1 : 1,
            ),
          );
        },
        cancel() {
          cancellations += 1;
          return cleanup;
        },
      });
      globalThis.fetch = (_input, init) => {
        upstreamSignal = init?.signal;
        return Promise.resolve(new Response(source, { status: 200 }));
      };
      let readOutcome: Promise<string> | undefined;
      try {
        const response = await harness.handler(request);
        assert(
          response.status === 200,
          "test did not enter target body streaming",
        );
        const signed = decodeResponseMetadata(
          response.headers.get(ONE_FETCH_RESPONSE_HEADER) ?? "",
        );
        assert(
          await verifySignedResponseMetadata(signed, {
            token: pathToken,
            requestId: metadata.requestId,
            nonce: metadata.nonce,
          }),
          "initial response signature or identity changed",
        );
        assert(
          signed.outcome === "target" &&
            signed.target?.kind === "http" &&
            !signed.target.bodyComplete,
          "initial target metadata claimed completed body",
        );
        readOutcome = response.arrayBuffer().then(
          () => "completed",
          (error: unknown) =>
            error instanceof Error ? error.name : "unknown-error",
        );
        if (mode === "cancel") requestAbort.abort();
        await harness.waitForReport();
        const expectedError =
          mode === "limit"
            ? "RangeError"
            : mode === "timeout"
              ? "TimeoutError"
              : "AbortError";
        assert(
          (await settledBeforeCleanup(readOutcome)) === expectedError,
          "finalized response still waited for upstream cleanup",
        );
        assert(
          cancellations === 1 && upstreamSignal?.aborted,
          "upstream was not cancelled exactly once",
        );
        assert(
          harness.reports.length === 1,
          "execution report finalized more than once",
        );
        const report = ExecutionReportV1Schema.parse(harness.reports[0]);
        const expectedOutcome =
          mode === "limit"
            ? "partial"
            : mode === "cancel"
              ? "cancelled"
              : "timeout";
        assert(
          report.outcome === expectedOutcome && !report.bodyComplete,
          "terminal report outcome changed",
        );
        assert(
          report.reportId === signed.reportId &&
            report.requestId === metadata.requestId,
          "terminal report identity changed",
        );
        assert(
          report.source === (mode === "limit" ? "target" : "relay"),
          "terminal source classification changed",
        );
        assert(
          report.problem?.code ===
            (mode === "limit" ? "response_too_large" : expectedOutcome),
          "terminal report problem changed",
        );
        assert(
          report.bodySha256 === undefined,
          "partial body gained a complete digest",
        );
        assert(
          harness.events.filter(
            (event) => event.action === `execution.${expectedOutcome}`,
          ).length === 1,
          "terminal audit was not written exactly once",
        );
        assert(
          !harness.events.some(
            (event) => event.action === "execution.completed",
          ),
          "late EOF created a successful audit",
        );
      } finally {
        requestAbort.abort();
        releaseCleanup();
        // Release old/broken monitors that never reached source.cancel().
        if (cancellations === 0) sourceController.close();
        await readOutcome;
        globalThis.fetch = originalFetch;
      }
    },
  );
}
