import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OneFetchExecutionError } from "../src/index.js";
import { createReportFixture } from "./report-fixture.js";

describe("report-aware response lifecycle", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it.each(["partial", "timeout"] as const)(
    "ends a hanging body with authenticated %s, without waiting for cleanup",
    async (outcome) => {
      const fixture = createReportFixture({ outcome, heldCleanup: true });
      const result = await fixture.execute();
      const reader = result.response.body!.getReader();
      expect(new TextDecoder().decode((await reader.read()).value)).toBe("abc");
      const pending = reader.read().catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(1_001);
      const error = await pending;
      expect(error).toBeInstanceOf(OneFetchExecutionError);
      expect(error).toMatchObject({
        code: outcome === "timeout" ? "timeout" : "response_too_large",
        report: { outcome, bodyComplete: false },
      });
      expect(error instanceof Error && error.message).not.toContain(
        "synthetic canary",
      );
      expect(result.classification.source).toBe("target");
      expect(result.response.status).toBe(200);
      expect(fixture.signal?.aborted).toBe(true);
      expect(fixture.cancel).toHaveBeenCalledTimes(1);
      expect(fixture.progress.some((event) => event.phase === "complete")).toBe(
        false,
      );
      expect(vi.getTimerCount()).toBe(0);
      fixture.release();
    },
  );

  it("does not close buffered target data when the report says completed", async () => {
    const fixture = createReportFixture({ outcome: "completed" });
    const result = await fixture.execute();
    const reader = result.response.body!.getReader();
    await reader.read();
    let settled = false;
    const pending = reader.read().then((value) => {
      settled = true;
      return value;
    });
    await vi.advanceTimersByTimeAsync(1_001);
    expect(settled).toBe(false);
    expect(fixture.progress.some((event) => event.phase === "complete")).toBe(
      false,
    );
    fixture.close();
    await expect(pending).resolves.toMatchObject({ done: true });
    expect(fixture.progress.at(-1)?.phase).toBe("complete");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("incurs no report traffic for a fast completed response", async () => {
    const fixture = createReportFixture();
    const result = await fixture.execute();
    fixture.close();
    expect(await result.response.text()).toBe("abc");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fixture.controlFetch).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    { watch: false },
    { signed: false },
    { wrongNonce: true },
    { headerStatus: 201 },
    { omitReport: true },
  ])(
    "never watches an unconfigured or unverified response: %j",
    async (options) => {
      const fixture = createReportFixture(options);
      const result = await fixture.execute(undefined, 3_000);
      const reading = result.response.text().catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(3_001);
      expect(await reading).toMatchObject({ name: "TimeoutError" });
      expect(fixture.controlFetch).not.toHaveBeenCalled();
    },
  );

  it("Stop cancels the in-flight report and ignores its late failure", async () => {
    let complete: ((response: Response) => void) | undefined;
    let response: Response | undefined;
    let reportSignal: AbortSignal | null | undefined;
    const fixture = createReportFixture({
      control: (report, init) => {
        response = Response.json(report);
        reportSignal = init?.signal;
        return new Promise((resolve) => {
          complete = resolve;
        });
      },
    });
    const abort = new AbortController();
    const result = await fixture.execute(abort.signal);
    const reading = result.response.text().catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(1_001);
    abort.abort(new DOMException("user Stop", "AbortError"));
    expect(await reading).toMatchObject({ name: "AbortError" });
    expect(reportSignal?.aborted).toBe(true);
    complete?.(response!);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fixture.controlFetch).toHaveBeenCalledTimes(1);
    expect(fixture.progress.some((event) => event.phase === "complete")).toBe(
      false,
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not replace completed EOF with a late incomplete report", async () => {
    let complete: ((response: Response) => void) | undefined;
    let response: Response | undefined;
    const fixture = createReportFixture({
      control: (report) => {
        response = Response.json(report);
        return new Promise((resolve) => {
          complete = resolve;
        });
      },
    });
    const result = await fixture.execute();
    const reading = result.response.text();
    await vi.advanceTimersByTimeAsync(1_001);
    fixture.close();
    expect(await reading).toBe("abc");
    complete?.(response!);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(
      fixture.progress.filter((event) => event.phase === "complete"),
    ).toHaveLength(1);
    expect(fixture.progress.some((event) => event.phase === "cancelling")).toBe(
      false,
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps the local deadline when Control reports are missing", async () => {
    const fixture = createReportFixture({
      control: () => Promise.resolve(new Response(null, { status: 404 })),
    });
    const result = await fixture.execute(undefined, 3_000);
    const reading = result.response.text().catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(3_001);
    expect(await reading).toMatchObject({ name: "TimeoutError" });
    expect(fixture.controlFetch).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("consumer cancellation returns promptly with pending source cleanup", async () => {
    const fixture = createReportFixture({ heldCleanup: true });
    const result = await fixture.execute();
    await result.response.body!.cancel();
    expect(fixture.signal?.aborted).toBe(true);
    expect(fixture.cancel).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(fixture.controlFetch).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    fixture.release();
  });

  it("network stream failure also removes report timers", async () => {
    const fixture = createReportFixture();
    const result = await fixture.execute();
    const reading = result.response.text().catch((error: unknown) => error);
    fixture.fail();
    expect(await reading).toMatchObject({ message: "network stream error" });
    expect(vi.getTimerCount()).toBe(0);
  });
});
