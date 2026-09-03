import type { OneFetchProblemV1 } from "@one-fetch/protocol";

export class GatewayProblem extends Error {
  constructor(
    readonly problem: OneFetchProblemV1,
    readonly status: number,
  ) {
    super(problem.message);
    this.name = "GatewayProblem";
  }
}

export function problem(
  code: OneFetchProblemV1["code"],
  stage: OneFetchProblemV1["stage"],
  message: string,
  status: number,
  retryable = false,
  details?: OneFetchProblemV1["details"],
): GatewayProblem {
  return new GatewayProblem(
    {
      code,
      origin: "adapter",
      stage,
      message,
      retryable,
      ...(details ? { details } : {}),
    },
    status,
  );
}

export function asGatewayProblem(error: unknown): GatewayProblem {
  if (error instanceof GatewayProblem) return error;
  if (error instanceof DOMException && error.name === "AbortError") {
    return problem(
      "cancelled",
      "cancellation",
      "The request was cancelled",
      499,
      false,
    );
  }
  return problem(
    "internal",
    "internal",
    "The Cloudflare adapter failed",
    500,
    false,
  );
}
