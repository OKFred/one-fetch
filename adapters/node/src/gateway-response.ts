import type { ServerResponse } from "node:http";

import { createSignedResponseMetadata } from "@one-fetch/core";
import {
  encodeResponseMetadata,
  ONE_FETCH_RESPONSE_HEADER,
  type OneFetchProblemV1,
  type OneFetchRequestMetaV1,
  type OneFetchTimingV1,
  type OneFetchUnsignedResponseMetaV1,
} from "@one-fetch/protocol";

export interface ResponseContext {
  auditState: "recorded" | "degraded" | "unknown";
  configVersion: string;
  metadata: OneFetchRequestMetaV1;
  reportId?: string;
  token: string;
}

const base = (
  context: ResponseContext,
  timing: OneFetchTimingV1,
): Omit<OneFetchUnsignedResponseMetaV1, "outcome" | "target" | "error"> => ({
  protocolVersion: 1,
  requestId: context.metadata.requestId,
  nonce: context.metadata.nonce,
  timing,
  configVersionUsed: context.configVersion,
  mutations: [],
  audit: { state: context.auditState },
  ...(context.reportId ? { reportId: context.reportId } : {}),
});

export const sendRelayError = async (
  response: ServerResponse,
  context: ResponseContext,
  problem: OneFetchProblemV1,
  status: number,
  timing: OneFetchTimingV1 = { phases: [], serverTiming: [] },
): Promise<void> => {
  const metadata = await createSignedResponseMetadata(
    { ...base(context, timing), error: problem, outcome: "relay-error" },
    context.token,
  );
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Type": "application/problem+json; charset=utf-8",
    [ONE_FETCH_RESPONSE_HEADER]: encodeResponseMetadata(metadata),
  });
  response.end(JSON.stringify({ error: problem }));
};

export const setTargetResponseMetadata = async (
  response: ServerResponse,
  context: ResponseContext,
  target: NonNullable<OneFetchUnsignedResponseMetaV1["target"]>,
  timing: OneFetchTimingV1,
): Promise<void> => {
  const metadata = await createSignedResponseMetadata(
    { ...base(context, timing), outcome: "target", target },
    context.token,
  );
  response.setHeader("Cache-Control", "no-store");
  response.setHeader(
    ONE_FETCH_RESPONSE_HEADER,
    encodeResponseMetadata(metadata),
  );
};
