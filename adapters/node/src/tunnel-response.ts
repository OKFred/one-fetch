import { createSignedResponseMetadata } from "@one-fetch/core";
import {
  createTunnelServerHello,
  encodeTunnelServerHello,
  type OneFetchProblemV1,
  type OneFetchRequestMetaV1,
  type OneFetchTimingV1,
  type TargetTunnelResponseV1,
} from "@one-fetch/protocol";

export interface TunnelResponseContext {
  auditState: "recorded" | "degraded" | "unknown";
  configVersion: string;
  metadata: OneFetchRequestMetaV1;
  token: string;
}

const sign = async (
  context: TunnelResponseContext,
  input:
    | { error: OneFetchProblemV1; outcome: "relay-error" }
    | { outcome: "target"; target: TargetTunnelResponseV1 },
  timing: OneFetchTimingV1 = { phases: [], serverTiming: [] },
): Promise<string> => {
  const response = await createSignedResponseMetadata(
    {
      audit: { state: context.auditState },
      configVersionUsed: context.configVersion,
      ...input,
      mutations: [],
      nonce: context.metadata.nonce,
      protocolVersion: 1,
      requestId: context.metadata.requestId,
      timing,
    },
    context.token,
  );
  return encodeTunnelServerHello(createTunnelServerHello(response));
};

export const signTunnelError = (
  context: TunnelResponseContext,
  problem: OneFetchProblemV1,
  timing?: OneFetchTimingV1,
): Promise<string> =>
  sign(context, { error: problem, outcome: "relay-error" }, timing);

export const signTunnelTarget = (
  context: TunnelResponseContext,
  target: TargetTunnelResponseV1,
  timing?: OneFetchTimingV1,
): Promise<string> => sign(context, { outcome: "target", target }, timing);
