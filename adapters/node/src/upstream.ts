import { lookup } from "node:dns/promises";
import {
  request as httpRequest,
  type IncomingMessage,
  type RequestOptions,
} from "node:http";
import { request as httpsRequest } from "node:https";
import type { RequestOptions as HttpsRequestOptions } from "node:https";
import { performance } from "node:perf_hooks";

import { HttpProxyAgent } from "http-proxy-agent";
import { HttpsProxyAgent } from "https-proxy-agent";
import { SocksProxyAgent } from "socks-proxy-agent";

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
  approveRedirect: (
    url: URL,
    headers: HeaderEntryV1[],
    hops: number,
  ) => Promise<boolean>;
  body: BodySpool;
  fetchOptions: FetchOptionsV1;
  headers: HeaderEntryV1[];
  method: string;
  pathAndQuery: string;
  signal: AbortSignal;
  targetOrigin: string;
}

const redirectStatus = new Set([301, 302, 303, 307, 308]);

const requestAgent = (
  target: URL,
  adapter: FetchOptionsV1["adapter"],
): RequestOptions["agent"] => {
  const proxy = typeof adapter?.proxy === "string" ? adapter.proxy : undefined;
  if (!proxy) return undefined;
  const proxyUrl = new URL(proxy);
  if (proxyUrl.protocol.startsWith("socks"))
    return new SocksProxyAgent(proxyUrl);
  if (target.protocol === "https:") return new HttpsProxyAgent(proxyUrl);
  return new HttpProxyAgent(proxyUrl);
};

const singleRequest = async (
  url: URL,
  method: string,
  headers: HeaderEntryV1[],
  body: BodySpool,
  options: FetchOptionsV1,
  signal: AbortSignal,
  sendBody: boolean,
): Promise<{ response: IncomingMessage; timing: TimingPhase[] }> => {
  const dnsStarted = performance.now();
  const addresses = await lookup(url.hostname, { all: true, verbatim: true });
  const dnsDuration = performance.now() - dnsStarted;
  const selected = addresses[0];
  if (!selected) throw new Error("Target hostname returned no addresses");

  const timing: TimingPhase[] = [
    {
      durationMs: dnsDuration,
      name: "dns",
      source: "gateway",
      state: "measured",
    },
  ];
  const started = performance.now();
  const agent = requestAgent(url, options.adapter);
  const bodyStream = sendBody ? body.createStream() : undefined;
  const tls = options.adapter ?? {};
  const requestOptions: HttpsRequestOptions = {
    agent,
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
    lookup: agent
      ? undefined
      : (_hostname, _options, callback) =>
          callback(null, selected.address, selected.family),
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
      const connectedAt = performance.now();
      socket.once("connect", () => {
        timing.push({
          durationMs: performance.now() - connectedAt,
          name: "connect",
          source: "gateway",
          state: "measured",
        });
      });
      socket.once("secureConnect", () => {
        timing.push({
          durationMs: performance.now() - connectedAt,
          name: "tls",
          source: "gateway",
          state: "measured",
        });
      });
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
  const timing: TimingPhase[] = [];

  while (true) {
    const result = await singleRequest(
      current,
      method,
      headers,
      input.body,
      input.fetchOptions,
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
    if (!(await input.approveRedirect(next, headers, redirects))) {
      result.response.resume();
      throw new Error("Redirect target was denied by policy");
    }
    result.response.resume();
    current = next;
  }
};
