import { createSignedResponseMetadata } from "@one-fetch/core";
import {
  createTunnelServerHello,
  encodeTunnelServerHello,
  type HeaderMutationNoticeV1,
  type OneFetchProblemV1,
  type OneFetchResponseMetaV1,
  type OneFetchTimingV1,
  type OneFetchUnsignedResponseMetaV1,
  type TargetTunnelResponseV1,
} from "@one-fetch/protocol";

import type { AuthorizationResult } from "../types";

export async function sendTunnelTargetHello(input: {
  socket: WebSocket;
  token: string;
  requestId: string;
  nonce: string;
  transport: "websocket" | "tcp" | "tls";
  target: Omit<TargetTunnelResponseV1, "kind" | "transport">;
  timing: OneFetchTimingV1;
  configVersion: string;
  mutations: HeaderMutationNoticeV1[];
  audit: AuthorizationResult["auditState"];
  auditEventId?: string;
  reportId: string;
}): Promise<OneFetchResponseMetaV1> {
  return sendSignedHello(input.socket, input.token, {
    protocolVersion: 1,
    requestId: input.requestId,
    nonce: input.nonce,
    outcome: "target",
    target: { kind: "tunnel", transport: input.transport, ...input.target },
    timing: input.timing,
    configVersionUsed: input.configVersion,
    mutations: input.mutations,
    audit: {
      state: input.audit,
      ...(input.auditEventId ? { eventId: input.auditEventId } : {}),
    },
    reportId: input.reportId,
  });
}

export async function sendTunnelErrorHello(input: {
  socket: WebSocket;
  token: string;
  requestId: string;
  nonce: string;
  problem: OneFetchProblemV1;
  configVersion: string;
  audit: AuthorizationResult["auditState"] | "unknown";
  reportId?: string;
}): Promise<OneFetchResponseMetaV1> {
  return sendSignedHello(input.socket, input.token, {
    protocolVersion: 1,
    requestId: input.requestId,
    nonce: input.nonce,
    outcome: "relay-error",
    error: input.problem,
    timing: { phases: [], serverTiming: [] },
    configVersionUsed: input.configVersion,
    mutations: [],
    audit: { state: input.audit },
    ...(input.reportId ? { reportId: input.reportId } : {}),
  });
}

async function sendSignedHello(
  socket: WebSocket,
  token: string,
  unsigned: OneFetchUnsignedResponseMetaV1,
): Promise<OneFetchResponseMetaV1> {
  const signed = await createSignedResponseMetadata(unsigned, token);
  socket.send(encodeTunnelServerHello(createTunnelServerHello(signed)));
  return signed;
}
