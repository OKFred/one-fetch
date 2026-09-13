import { vi } from "vitest";
import { createSignedResponseMetadata } from "@one-fetch/core";
import {
  ONE_FETCH_REQUEST_HEADER,
  ONE_FETCH_RESPONSE_HEADER,
  decodeRequestMetadata,
  encodeResponseMetadata,
  type ExecutionReportV1,
  type OneFetchRequestMetaV1,
} from "@one-fetch/protocol";
import { OneFetchGatewayClient, type GatewayProgress } from "../src/index.js";

export const REPORT_TOKEN = "of_synthetic_report_watcher_execution_token";
export function createReportFixture(
  options: {
    watch?: boolean;
    signed?: boolean;
    wrongNonce?: boolean;
    headerStatus?: number;
    omitReport?: boolean;
    heldCleanup?: boolean;
    outcome?: ExecutionReportV1["outcome"];
    control?: (
      report: ExecutionReportV1,
      init: RequestInit | undefined,
    ) => Promise<Response>;
  } = {},
) {
  let metadata: OneFetchRequestMetaV1 | undefined;
  let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
  let release: (() => void) | undefined;
  let gatewaySignal: AbortSignal | null | undefined;
  const progress: GatewayProgress[] = [];
  const cancel = vi.fn(() =>
    options.heldCleanup
      ? new Promise<void>((resolve) => {
          release = resolve;
        })
      : undefined,
  );
  const controlFetch = vi.fn<typeof globalThis.fetch>((_input, init) => {
    if (!metadata) throw new Error("Gateway must run first");
    const outcome = options.outcome ?? "partial";
    const report: ExecutionReportV1 = {
      schemaVersion: 1,
      reportId: "bound-report",
      requestId: metadata.requestId,
      outcome,
      source:
        outcome === "partial" || outcome === "completed" ? "target" : "relay",
      status: 200,
      responseBytes: 3,
      bodyComplete: outcome === "completed",
      timing: { phases: [], serverTiming: [] },
      problem: {
        code: outcome === "timeout" ? "timeout" : "response_too_large",
        origin: "adapter",
        stage: "upstream-body",
        message: "synthetic canary",
        retryable: false,
      },
      finishedAt: new Date().toISOString(),
      auditState: "recorded",
    };
    return options.control
      ? options.control(report, init)
      : Promise.resolve(Response.json(report));
  });
  const client = new OneFetchGatewayClient({
    gatewayUrl: "https://gateway.example",
    token: REPORT_TOKEN,
    ...(options.watch === false
      ? {}
      : {
          executionReports: {
            controlUrl: "https://control.example",
            fetch: controlFetch,
          },
        }),
    fetch: async (_input, init) => {
      gatewaySignal = init?.signal;
      metadata = decodeRequestMetadata(
        new Headers(init?.headers).get(ONE_FETCH_REQUEST_HEADER)!,
      );
      const encoded = encodeResponseMetadata(
        await createSignedResponseMetadata(
          {
            protocolVersion: 1,
            requestId: metadata.requestId,
            nonce: options.wrongNonce ? "ab".repeat(16) : metadata.nonce,
            outcome: "target",
            target: {
              kind: "http",
              status: options.headerStatus ?? 200,
              statusText: "OK",
              headers: [],
              setCookie: [],
              bodyComplete: false,
            },
            timing: { phases: [], serverTiming: [] },
            configVersionUsed: "v1",
            mutations: [],
            audit: { state: "recorded" },
            ...(options.omitReport ? {} : { reportId: "bound-report" }),
          },
          REPORT_TOKEN,
        ),
      );
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            stream = controller;
            controller.enqueue(new TextEncoder().encode("abc"));
          },
          cancel,
        }),
        {
          headers:
            options.signed === false
              ? {}
              : { [ONE_FETCH_RESPONSE_HEADER]: encoded },
        },
      );
    },
  });
  return {
    client,
    controlFetch,
    cancel,
    progress,
    get signal() {
      return gatewaySignal;
    },
    close: () => stream?.close(),
    fail: () => stream?.error(new Error("network stream error")),
    release: () => release?.(),
    execute: (signal?: AbortSignal, timeoutMs = 60_000) =>
      client.executeHttp({
        method: "GET",
        targetUrl: "https://target.example/data",
        ...(signal ? { signal } : {}),
        fetchOptions: { timeoutMs },
        onProgress: (value) => progress.push(value),
      }),
  };
}
