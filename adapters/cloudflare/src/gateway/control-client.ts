import type {
  AuthorizationInput,
  AuthorizationResult,
  CompletionInput,
  ExecutionDecisionInput,
  Transport,
} from "../types";
import { authorizationResultSchema } from "../service-schemas";

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
  await control.releaseExecutionJson(JSON.stringify(input));
}

export async function recordExecutionDecision(
  control: CloudflareGatewayEnv["CONTROL"],
  input: ExecutionDecisionInput,
): Promise<"recorded" | "degraded"> {
  return control.recordExecutionDecisionJson(JSON.stringify(input));
}

export async function renewExecution(
  control: CloudflareGatewayEnv["CONTROL"],
  tokenId: string,
  requestId: string,
): Promise<boolean> {
  return control.renewExecutionJson(tokenId, requestId);
}
