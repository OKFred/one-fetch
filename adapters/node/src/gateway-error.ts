import type { OneFetchProblemV1 } from "@one-fetch/protocol";

export class GatewayFailure extends Error {
  constructor(
    readonly problem: OneFetchProblemV1,
    readonly status: number,
    options?: ErrorOptions,
  ) {
    super(problem.message, options);
    this.name = "GatewayFailure";
  }
}

export const failure = (
  code: OneFetchProblemV1["code"],
  stage: OneFetchProblemV1["stage"],
  message: string,
  status: number,
  retryable = false,
): GatewayFailure =>
  new GatewayFailure(
    { code, message, origin: "one-fetch", retryable, stage },
    status,
  );

export const abortedGatewayFailure = (signal: AbortSignal): GatewayFailure =>
  signal.reason instanceof GatewayFailure
    ? signal.reason
    : failure("cancelled", "cancellation", "Request was cancelled", 499);
