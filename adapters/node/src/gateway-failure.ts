import {
  abortedGatewayFailure,
  failure,
  GatewayFailure,
} from "./gateway-error.js";
import { TargetPolicyDeniedError } from "./upstream.js";

// Never expose database, socket or other internal error details to clients.
export const classifyGatewayFailure = (
  error: unknown,
  signal: AbortSignal,
): GatewayFailure => {
  if (error instanceof GatewayFailure) return error;
  if (error instanceof TargetPolicyDeniedError)
    return failure(
      "target_not_allowed",
      "policy",
      "Resolved target addresses were denied by policy",
      403,
    );
  if (signal.aborted) return abortedGatewayFailure(signal);
  return failure(
    "upstream_network",
    "internal",
    "Gateway request failed",
    502,
    true,
  );
};
