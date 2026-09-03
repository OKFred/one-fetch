import {
  ONE_FETCH_WEBSOCKET_PROTOCOL,
  OneFetchRequestMetaV1Schema,
  createTunnelClientHello,
  decodeTunnelServerHello,
  encodeResponseMetadata,
  encodeTunnelClientHello,
  type OneFetchRequestMetaV1,
} from "@one-fetch/protocol";
import {
  classifyOneFetchResponse,
  type OneFetchResponseClassification,
} from "@one-fetch/core";

import { parseServiceOrigin } from "./url.js";

export interface PreparedTunnelHandshake {
  url: string;
  protocols: [typeof ONE_FETCH_WEBSOCKET_PROTOCOL];
  firstFrame: string;
  request: OneFetchRequestMetaV1;
}

export interface PrepareTunnelHandshakeOptions {
  gatewayUrl: string;
  executionToken: string;
  request: OneFetchRequestMetaV1;
  targetPathAndQuery?: string;
}

function websocketGatewayUrl(gatewayUrl: string, pathAndQuery: string): string {
  if (!pathAndQuery.startsWith("/"))
    throw new TypeError("Tunnel target path must start with /");
  const url = parseServiceOrigin(gatewayUrl, "Gateway URL");
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  const targetPath = new URL(pathAndQuery, "https://path.invalid");
  url.pathname = targetPath.pathname;
  url.search = targetPath.search;
  return url.href;
}

export function prepareTunnelHandshake(
  options: PrepareTunnelHandshakeOptions,
): PreparedTunnelHandshake {
  const request = OneFetchRequestMetaV1Schema.parse(options.request);
  if (request.transport === "http")
    throw new TypeError("HTTP does not use a WebSocket tunnel handshake");
  const pathAndQuery =
    request.transport === "websocket"
      ? (options.targetPathAndQuery ?? "/")
      : "/";
  const hello = createTunnelClientHello(request, options.executionToken);
  return {
    url: websocketGatewayUrl(options.gatewayUrl, pathAndQuery),
    protocols: [ONE_FETCH_WEBSOCKET_PROTOCOL],
    firstFrame: encodeTunnelClientHello(hello),
    request,
  };
}

export async function classifyTunnelServerHello(
  frame: string,
  options: { executionToken: string; request: OneFetchRequestMetaV1 },
): Promise<OneFetchResponseClassification> {
  const hello = decodeTunnelServerHello(frame);
  return classifyOneFetchResponse(encodeResponseMetadata(hello.response), {
    token: options.executionToken,
    requestId: options.request.requestId,
    nonce: options.request.nonce,
  });
}
