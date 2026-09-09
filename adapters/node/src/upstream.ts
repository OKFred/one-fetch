import { lookup } from "node:dns/promises";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import type { RequestOptions as HttpsRequestOptions } from "node:https";
import type { LookupFunction, Socket } from "node:net";
import { performance } from "node:perf_hooks";

import type {
  FetchOptionsV1,
  HeaderEntryV1,
  OneFetchTimingV1,
} from "@one-fetch/protocol";

import type { BodySpool } from "./body-spool.js";
import {
  fromRawHeaders,
  stripBodyHeaders,
  stripSensitiveRedirectHeaders,
  toNodeHeaderArray,
} from "./headers.js";

type TimingPhase = OneFetchTimingV1["phases"][number];

export interface UpstreamResult {
  headers: HeaderEntryV1[];
  redirects: number;
  response: IncomingMessage;
  status: number;
  statusText: string;
  timing: TimingPhase[];
  url: URL;
}

interface ExecuteUpstreamOptions {
  approveTarget: (
    url: URL,
    headers: HeaderEntryV1[],
    hops: number,
    resolvedIps: string[],
    method: string,
  ) => boolean | Promise<boolean>;
  body: BodySpool;
  fetchOptions: FetchOptionsV1;
  headers: HeaderEntryV1[];
  method: string;
  pathAndQuery: string;
  signal: AbortSignal;
  targetOrigin: string;
  initialResolution: ResolvedTarget;
}

export interface ResolvedTarget {
  address: string;
  dnsDurationMs: number;
  family: number;
}

type TargetApprover = ExecuteUpstreamOptions["approveTarget"];

export const pinnedLookup =
  (resolution: ResolvedTarget): LookupFunction =>
  (_hostname, options, callback) => {
    if (options.all) {
      callback(null, [
        { address: resolution.address, family: resolution.family },
      ]);
      return;
    }
    callback(null, resolution.address, resolution.family);
  };

export function observeSocketTiming(
  socket: Socket,
  secure: boolean,
  timing: TimingPhase[],
  connectedAt = performance.now(),
): void {
  if (!socket.connecting) {
    timing.push({
      name: "connect",
      source: "gateway",
      state: "reused",
      detail: "The upstream connection was reused.",
    });
    if (secure) {
      timing.push({
        name: "tls",
        source: "gateway",
        state: "reused",
        detail: "The upstream TLS session was reused with the connection.",
      });
    }
    return;
  }
  socket.once("connect", () => {
    timing.push({
      durationMs: performance.now() - connectedAt,
      name: "connect",
      source: "gateway",
      state: "measured",
    });
  });
  if (secure) {
    socket.once("secureConnect", () => {
      timing.push({
        durationMs: performance.now() - connectedAt,
        name: "tls",
        source: "gateway",
        state: "measured",
      });
    });
  }
}

export class TargetPolicyDeniedError extends Error {
  constructor() {
    super("No resolved target address was approved by policy");
    this.name = "TargetPolicyDeniedError";
  }
}

export const resolveApprovedTarget = async (
  url: URL,
  headers: HeaderEntryV1[],
  hops: number,
  method: string,
  approve: TargetApprover,
): Promise<ResolvedTarget> => {
  const dnsStarted = performance.now();
  const addresses = await lookup(url.hostname, { all: true, verbatim: true });
  const dnsDurationMs = performance.now() - dnsStarted;
  for (const candidate of addresses) {
    if (await approve(url, headers, hops, [candidate.address], method)) {
      return {
        address: candidate.address,
        dnsDurationMs,
        family: candidate.family,
      };
    }
  }
  throw new TargetPolicyDeniedError();
};

const redirectStatus = new Set([301, 302, 303, 307, 308]);

const singleRequest = async (
  url: URL,
  method: string,
  headers: HeaderEntryV1[],
  body: BodySpool,
  options: FetchOptionsV1,
  resolution: ResolvedTarget,
  signal: AbortSignal,
  sendBody: boolean,
): Promise<{ response: IncomingMessage; timing: TimingPhase[] }> => {
  const timing: TimingPhase[] = [
    {
      durationMs: resolution.dnsDurationMs,
      name: "dns",
      source: "gateway",
      state: "measured",
    },
  ];
  const started = performance.now();
  const bodyStream = sendBody ? body.createStream() : undefined;
  const tls = options.adapter ?? {};
  const requestOptions: HttpsRequestOptions = {
    ca: typeof tls.caPem === "string" ? tls.caPem : undefined,
    cert:
      typeof tls.clientCertificatePem === "string"
        ? tls.clientCertificatePem
        : undefined,
    headers: [
      ...toNodeHeaderArray(headers),
      "Host",
      url.host,
      ...(sendBody && body.sizeBytes > 0
        ? ["Content-Length", String(body.sizeBytes)]
        : []),
    ],
    host: url.hostname,
    key:
      typeof tls.clientPrivateKeyPem === "string"
        ? tls.clientPrivateKeyPem
        : undefined,
    lookup: pinnedLookup(resolution),
    method,
    path: `${url.pathname}${url.search}`,
    port: url.port || undefined,
    rejectUnauthorized: tls.rejectUnauthorized !== false,
    servername: url.hostname,
    signal,
  };
  const factory = url.protocol === "https:" ? httpsRequest : httpRequest;
  const response = await new Promise<IncomingMessage>((resolve, reject) => {
    const outgoing = factory(requestOptions);
    outgoing.once("socket", (socket) => {
      observeSocketTiming(socket, url.protocol === "https:", timing);
    });
    outgoing.once("response", (incoming) => {
      timing.push({
        durationMs: performance.now() - started,
        name: "ttfb",
        source: "gateway",
        state: "measured",
      });
      resolve(incoming);
    });
    outgoing.once("error", reject);
    if (bodyStream) bodyStream.pipe(outgoing);
    else outgoing.end();
  });
  return { response, timing };
};

export const executeUpstream = async (
  input: ExecuteUpstreamOptions,
): Promise<UpstreamResult> => {
  let current = new URL(input.pathAndQuery, input.targetOrigin);
  let method = input.method;
  let headers = input.headers;
  let redirects = 0;
  let sendBody = input.body.sizeBytes > 0;
  let resolution = input.initialResolution;
  const timing: TimingPhase[] = [];

  while (true) {
    const result = await singleRequest(
      current,
      method,
      headers,
      input.body,
      input.fetchOptions,
      resolution,
      input.signal,
      sendBody,
    );
    timing.push(...result.timing);
    const status = result.response.statusCode ?? 502;
    const location = result.response.headers.location;
    if (!redirectStatus.has(status) || !location) {
      return {
        headers: fromRawHeaders(result.response.rawHeaders),
        redirects,
        response: result.response,
        status,
        statusText: result.response.statusMessage ?? "",
        timing,
        url: current,
      };
    }
    if (input.fetchOptions.redirect === "manual") {
      return {
        headers: fromRawHeaders(result.response.rawHeaders),
        redirects,
        response: result.response,
        status,
        statusText: result.response.statusMessage ?? "",
        timing,
        url: current,
      };
    }
    if (input.fetchOptions.redirect === "error") {
      result.response.resume();
      throw new Error("Redirect was disallowed by fetch options");
    }
    redirects += 1;
    if (redirects > 20) {
      result.response.resume();
      throw new Error("Redirect limit exceeded");
    }
    const next = new URL(location, current);
    const crossOrigin = next.origin !== current.origin;
    if (crossOrigin) headers = stripSensitiveRedirectHeaders(headers);
    if (
      status === 303 ||
      ((status === 301 || status === 302) && method.toUpperCase() === "POST")
    ) {
      method = "GET";
      headers = stripBodyHeaders(headers);
      sendBody = false;
    }
    result.response.resume();
    resolution = await resolveApprovedTarget(
      next,
      headers,
      redirects,
      method,
      input.approveTarget,
    );
    current = next;
  }
};
