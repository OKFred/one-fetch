import type {
  AuthorizationInput,
  AuthorizationResult,
  CompletionInput,
  DecisionRecordResult,
  ExecutionDecisionInput,
  Transport,
} from "../types";
import { authorizationResultSchema } from "../service-schemas";
import { problem } from "./errors";

export async function authorizeExecution(
  control: CloudflareGatewayEnv["CONTROL"],
  input: AuthorizationInput,
): Promise<AuthorizationResult> {
  return authorizationResultSchema.parse(
    JSON.parse(
      await control.authorizeExecutionJson(JSON.stringify(input)),
    ) as unknown,
  ) as unknown as AuthorizationResult;
}

export async function checkTarget(
  control: CloudflareGatewayEnv["CONTROL"],
  token: string,
  transport: Transport,
  targetUrl: string,
): Promise<AuthorizationResult> {
  return authorizationResultSchema.parse(
    JSON.parse(
      await control.checkTargetJson(token, transport, targetUrl),
    ) as unknown,
  ) as unknown as AuthorizationResult;
}

export async function completeExecution(
  control: CloudflareGatewayEnv["CONTROL"],
  input: CompletionInput,
): Promise<void> {
  const result = await control.releaseExecutionJson(JSON.stringify(input));
  if (result === "storage_unavailable") throw storageUnavailableProblem();
}

export async function recordExecutionDecision(
  control: CloudflareGatewayEnv["CONTROL"],
  input: ExecutionDecisionInput,
): Promise<DecisionRecordResult> {
  return control.recordExecutionDecisionJson(JSON.stringify(input));
}

export async function renewExecution(
  control: CloudflareGatewayEnv["CONTROL"],
  tokenId: string,
  requestId: string,
): Promise<boolean> {
  const result = await control.renewExecutionJson(tokenId, requestId);
  return result === true;
}

function storageUnavailableProblem() {
  return problem(
    "storage_unavailable",
    "storage",
    "The Control database migration state is incompatible",
    503,
    true,
  );
}
