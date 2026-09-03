import type {
  AuthorizationInput,
  AuthorizationResult,
  CompletionInput,
  ExecutionDecisionInput,
} from "../types";
import {
  authorizeExecution,
  completeExecution,
  recordExecutionDecision,
  renewExecution,
} from "./control-client";
import { openTargetWebSocket } from "./websocket";

export interface TunnelDependencies {
  authorize(
    control: CloudflareGatewayEnv["CONTROL"],
    input: AuthorizationInput,
  ): Promise<AuthorizationResult>;
  complete(
    control: CloudflareGatewayEnv["CONTROL"],
    input: CompletionInput,
  ): Promise<void>;
  recordDecision(
    control: CloudflareGatewayEnv["CONTROL"],
    input: ExecutionDecisionInput,
  ): Promise<"recorded" | "degraded">;
  renew(
    control: CloudflareGatewayEnv["CONTROL"],
    tokenId: string,
    requestId: string,
  ): Promise<boolean>;
  openWebSocket(
    target: URL,
    headers: Headers,
    signal: AbortSignal,
  ): Promise<Response>;
}

export const DEFAULT_TUNNEL_DEPENDENCIES: TunnelDependencies = {
  authorize: authorizeExecution,
  complete: completeExecution,
  recordDecision: recordExecutionDecision,
  renew: renewExecution,
  openWebSocket: openTargetWebSocket,
};
