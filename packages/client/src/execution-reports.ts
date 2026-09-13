import { CONTROL_ROUTES_V1, type ExecutionReportV1 } from "@one-fetch/protocol";

import {
  fetchExecutionReport,
  type ReportAttempt,
} from "./report-transport.js";
import { buildServiceUrl, serviceBaseUrl } from "./url.js";

export interface ExecutionReportWatchOptions {
  /** Explicitly trusted Control base URL. Never inferred from response headers. */
  controlUrl: string;
  /** Optional Control transport, independent of the Gateway transport. */
  fetch?: typeof globalThis.fetch;
}

export class OneFetchExecutionError extends Error {
  readonly report: ExecutionReportV1;
  readonly code: string;
  constructor(report: ExecutionReportV1) {
    // Do not copy server-provided prose into the generic error/log message.
    super(`Execution ended with an incomplete response (${report.outcome})`);
    this.name = "OneFetchExecutionError";
    this.report = report;
    this.code = report.problem?.code ?? "execution_incomplete";
  }
}

interface ReportIdentity {
  reportId: string;
  requestId: string;
  status: number;
}

export function createExecutionReportWatcher(
  options: ExecutionReportWatchOptions,
): (
  identity: ReportIdentity,
  token: string,
  onIncomplete: (error: OneFetchExecutionError) => void,
) => () => void {
  const base = serviceBaseUrl(
    options.controlUrl,
    "Execution report Control URL",
  );
  const request = options.fetch ?? globalThis.fetch;
  return (identity, token, onIncomplete) => {
    const url = buildServiceUrl(
      base,
      CONTROL_ROUTES_V1.executionReport(identity.reportId),
      "Execution report Control URL",
    );
    let stopped = false;
    let attempts = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let active: AbortController | undefined;
    const stop = (): void => {
      stopped = true;
      clearTimeout(timer);
      active?.abort();
    };
    const poll = async (): Promise<void> => {
      if (stopped || attempts >= 60) {
        stop();
        return;
      }
      attempts += 1;
      const abort = new AbortController();
      active = abort;
      let deadline: ReturnType<typeof setTimeout> | undefined;
      let wake: (() => void) | undefined;
      let result: ReportAttempt;
      try {
        const interrupted = new Promise<ReportAttempt>((resolve) => {
          wake = () => resolve({ state: "retry" });
          abort.signal.addEventListener("abort", wake, { once: true });
          deadline = setTimeout(() => abort.abort(), 2_000);
        });
        result = await Promise.race([
          fetchExecutionReport(url, token, abort.signal, request),
          interrupted,
        ]);
      } finally {
        clearTimeout(deadline);
        if (wake) abort.signal.removeEventListener("abort", wake);
        abort.abort();
        active = undefined;
      }
      if (stopped) return;
      if (result.state === "ready") {
        const { report } = result;
        stop();
        // reportId came from nonce-verified target metadata. Both identities and
        // HTTP status must agree; timestamps alone cannot prove freshness.
        if (
          report.reportId !== identity.reportId ||
          report.requestId !== identity.requestId ||
          report.status !== identity.status
        )
          return;
        if (
          report.outcome === "completed" ||
          report.bodyComplete ||
          report.bodySha256 !== undefined
        )
          return;
        onIncomplete(new OneFetchExecutionError(report));
      } else if (result.state === "unavailable") stop();
      else
        timer = setTimeout(
          () => {
            void poll().catch(stop);
          },
          result.state === "retry" ? 2_000 : 1_000,
        );
    };
    // Fast responses incur no Control traffic. Polls never overlap and have a
    // fixed request-count cap, per-request deadline and lifecycle cancellation.
    timer = setTimeout(() => {
      void poll().catch(stop);
    }, 1_000);
    return stop;
  };
}
