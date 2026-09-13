import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExecutionReportV1 } from "@one-fetch/protocol";
import {
  createExecutionReportWatcher,
  OneFetchExecutionError,
} from "../src/execution-reports.js";

const token = "of_execution_secret_never_in_query_or_logs";
const identity = { reportId: "report-1", requestId: "request-1", status: 200 };
function report(patch: Partial<ExecutionReportV1> = {}): ExecutionReportV1 {
  return {
    schemaVersion: 1,
    ...identity,
    outcome: "partial",
    source: "target",
    responseBytes: 20_971_521,
    bodyComplete: false,
    timing: { phases: [], serverTiming: [] },
    finishedAt: "2026-09-13T00:00:00.000Z",
    auditState: "recorded",
    ...patch,
  };
}
function watch(fetch: typeof globalThis.fetch) {
  const failed = vi.fn<(error: OneFetchExecutionError) => void>();
  const stop = createExecutionReportWatcher({
    controlUrl: "https://project.example/functions/v1/control",
    fetch,
  })(identity, token, failed);
  return { failed, stop };
}

describe("bounded execution report watcher", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("sends only the execution bearer to the explicitly configured Control path", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>((input, init) => {
      const request = new Request(input, init);
      expect(request.url).toBe(
        "https://project.example/functions/v1/control/api/v1/reports/report-1",
      );
      expect([...request.headers.entries()]).toEqual([
        ["accept", "application/json"],
        ["authorization", `Bearer ${token}`],
      ]);
      expect(init).toMatchObject({
        method: "GET",
        credentials: "omit",
        redirect: "error",
        referrerPolicy: "no-referrer",
        cache: "no-store",
      });
      return Promise.resolve(Response.json(report()));
    });
    const { failed, stop } = watch(fetch);
    expect(fetch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(failed).toHaveBeenCalledExactlyOnceWith(
      expect.any(OneFetchExecutionError),
    );
    expect(failed.mock.calls[0]?.[0]).toMatchObject({
      code: "execution_incomplete",
      report: { outcome: "partial", source: "target" },
    });
    expect(vi.getTimerCount()).toBe(0);
    stop();
  });

  it.each([
    "partial",
    "timeout",
    "cancelled",
    "relay-error",
    "orphaned",
  ] as const)(
    "rejects terminal %s without changing target bytes",
    async (outcome) => {
      const { failed } = watch(() =>
        Promise.resolve(
          Response.json(
            report({
              outcome,
              source: outcome === "partial" ? "target" : "relay",
            }),
          ),
        ),
      );
      await vi.advanceTimersByTimeAsync(1_000);
      expect(failed).toHaveBeenCalledTimes(1);
      expect(failed.mock.calls[0]?.[0].report.outcome).toBe(outcome);
    },
  );

  it.each([
    { reportId: "stale-report" },
    { requestId: "old-request" },
    { status: 201 },
    { outcome: "completed", bodyComplete: true },
    { bodyComplete: true },
    { bodySha256: "a".repeat(64) },
    { schemaVersion: 2 },
    { unknown: true },
  ])("ignores an unrelated, complete or invalid report: %j", async (patch) => {
    const fetch = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(Response.json({ ...report(), ...patch })),
    );
    const { failed } = watch(fetch);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(failed).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds missing reports to 60 serial attempts", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(new Response(null, { status: 404 })),
    );
    const { failed, stop } = watch(fetch);
    await vi.advanceTimersByTimeAsync(65_000);
    expect(fetch).toHaveBeenCalledTimes(60);
    expect(failed).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    stop();
  });

  it("backs off after temporary failure and later recognizes the exact report", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(null, { status: 429 }))
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(Response.json(report()));
    const { failed } = watch(fetch);
    await vi.advanceTimersByTimeAsync(5_999);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(failed).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(failed).toHaveBeenCalledTimes(1);
  });

  it.each([301, 401, 403, 501])(
    "handles HTTP %s without treating it as the execution result",
    async (status) => {
      const fetch = vi.fn<typeof globalThis.fetch>(() =>
        Promise.resolve(new Response(null, { status })),
      );
      const { failed, stop } = watch(fetch);
      await vi.advanceTimersByTimeAsync(3_000);
      expect(failed).not.toHaveBeenCalled();
      expect(fetch).toHaveBeenCalledTimes(status >= 500 ? 2 : 1);
      stop();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("bounds a hung Control fetch and ignores its late response after Stop", async () => {
    let resolveResponse: ((response: Response) => void) | undefined;
    let signal: AbortSignal | null | undefined;
    const fetch = vi.fn<typeof globalThis.fetch>((_input, init) => {
      signal = init?.signal;
      return new Promise((resolve) => {
        resolveResponse = resolve;
      });
    });
    const { failed, stop } = watch(fetch);
    await vi.advanceTimersByTimeAsync(3_001);
    expect(signal?.aborted).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
    stop();
    resolveResponse?.(Response.json(report()));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(failed).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds a hanging report body and cancels its reader", async () => {
    const cancel = vi.fn();
    const fetch = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(new Response(new ReadableStream({ cancel }))),
    );
    const { failed, stop } = watch(fetch);
    await vi.advanceTimersByTimeAsync(3_001);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(failed).not.toHaveBeenCalled();
    stop();
  });

  it.each([true, false])(
    "bounds report metadata with/without Content-Length (%s)",
    async (declared) => {
      const cancel = vi.fn();
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(49_153));
        },
        cancel,
      });
      const { failed } = watch(() =>
        Promise.resolve(
          new Response(body, {
            headers: declared ? { "Content-Length": "49153" } : {},
          }),
        ),
      );
      await vi.advanceTimersByTimeAsync(5_000);
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(failed).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("never includes server prose or credentials in the thrown message", async () => {
    // An arbitrary invalid problem disables the watcher rather than being logged.
    const { failed } = watch(() =>
      Promise.resolve(
        Response.json({ ...report(), problem: { message: token } }),
      ),
    );
    await vi.advanceTimersByTimeAsync(1_000);
    expect(failed).not.toHaveBeenCalled();
    const error = new OneFetchExecutionError(report());
    expect(error.message).not.toContain(token);
  });

  it.each([
    "http://remote.example",
    "https://user:pass@control.example",
    "https://control.example?token=secret",
    "https://control.example/#fragment",
  ])("rejects unsafe Control URL %s before I/O", (controlUrl) => {
    expect(() => createExecutionReportWatcher({ controlUrl })).toThrow(
      TypeError,
    );
  });
});
