import type { IncomingMessage } from "node:http";

import type { HeaderEntryV1, OneFetchRequestMetaV1 } from "@one-fetch/protocol";
import WebSocket from "ws";

import { fromRawHeaders, setCookieValues } from "./headers.js";
import { tunnelDataToBuffer } from "./tunnel-data.js";
import type { ApprovedTunnelTarget } from "./tunnel-policy.js";
import type { TunnelByteGate, TunnelTransferResult } from "./tunnel-socket.js";

export interface WebSocketHandshake {
  headers: HeaderEntryV1[];
  setCookie: string[];
  status: number;
  statusText: string;
}

export type WebSocketTargetResult =
  | { handshake: WebSocketHandshake; socket: WebSocket; state: "established" }
  | { handshake: WebSocketHandshake; state: "rejected" };

const protocolsAndHeaders = (entries: HeaderEntryV1[]) => {
  const protocols: string[] = [];
  const grouped = new Map<string, { name: string; values: string[] }>();
  for (const { name, value } of entries) {
    if (name.toLowerCase() === "sec-websocket-protocol") {
      protocols.push(
        ...value
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean),
      );
      continue;
    }
    const key = name.toLowerCase();
    const current = grouped.get(key) ?? { name, values: [] };
    current.values.push(value);
    grouped.set(key, current);
  }
  const headers: Record<string, string | string[]> = {};
  for (const { name, values } of grouped.values()) {
    headers[name] = values.length === 1 ? values[0]! : values;
  }
  return { headers, protocols: [...new Set(protocols)] };
};

const handshake = (response: IncomingMessage): WebSocketHandshake => {
  const headers = fromRawHeaders(response.rawHeaders);
  return {
    headers,
    setCookie: setCookieValues(response.headers, headers),
    status: response.statusCode ?? 500,
    statusText: response.statusMessage ?? "",
  };
};

export const connectWebSocketTarget = (
  metadata: OneFetchRequestMetaV1,
  target: ApprovedTunnelTarget,
  signal: AbortSignal,
): Promise<WebSocketTargetResult> => {
  const url = new URL(target.url!);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  const { headers, protocols } = protocolsAndHeaders(metadata.targetHeaders);
  const adapter = metadata.fetchOptions.adapter ?? {};
  const socket = new WebSocket(url, protocols, {
    ca: typeof adapter.caPem === "string" ? adapter.caPem : undefined,
    cert:
      typeof adapter.clientCertificatePem === "string"
        ? adapter.clientCertificatePem
        : undefined,
    followRedirects: false,
    headers: headers as unknown as Record<string, string>,
    key:
      typeof adapter.clientPrivateKeyPem === "string"
        ? adapter.clientPrivateKeyPem
        : undefined,
    lookup: (_hostname, _options, callback) =>
      callback(null, target.resolution.address, target.resolution.family),
    rejectUnauthorized: adapter.rejectUnauthorized !== false,
  });

  return new Promise((resolve, reject) => {
    let observed: WebSocketHandshake | undefined;
    let settled = false;
    const abort = () => socket.terminate();
    const cleanup = () => {
      signal.removeEventListener("abort", abort);
      socket.off("error", onError);
      socket.off("unexpected-response", onUnexpected);
    };
    const onError = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onUnexpected = (_request: unknown, response: IncomingMessage) => {
      if (settled) return;
      settled = true;
      const rejected = handshake(response);
      response.resume();
      cleanup();
      resolve({ handshake: rejected, state: "rejected" });
    };
    signal.addEventListener("abort", abort, { once: true });
    socket.once("upgrade", (response) => {
      observed = handshake(response);
    });
    socket.once("unexpected-response", onUnexpected);
    socket.once("error", onError);
    socket.once("open", () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({
        handshake: observed ?? {
          headers: [],
          setCookie: [],
          status: 101,
          statusText: "Switching Protocols",
        },
        socket,
        state: "established",
      });
    });
  });
};

const dataLength = (data: WebSocket.RawData): number =>
  tunnelDataToBuffer(data).byteLength;

const allowAllBytes: TunnelByteGate = () => Promise.resolve();

export const bridgeWebSockets = (
  client: WebSocket,
  target: WebSocket,
  chargeBytes: TunnelByteGate = allowAllBytes,
): Promise<TunnelTransferResult> =>
  new Promise((resolve) => {
    let bytesUp = 0;
    let bytesDown = 0;
    let settled = false;
    const finish = (reason: string) => {
      if (settled) return;
      settled = true;
      resolve({ bytesDown, bytesUp, reason });
    };
    client.on("message", (data, binary) => {
      const bytes = dataLength(data);
      bytesUp += bytes;
      client.pause();
      void chargeBytes(bytes)
        .then(() => {
          if (settled) return;
          target.send(data, { binary }, (error) => {
            client.resume();
            if (error) finish("target-error");
          });
        })
        .catch(() => {
          client.close(1008, "Quota exceeded");
          target.terminate();
          finish("quota-exceeded");
        });
    });
    target.on("message", (data, binary) => {
      const bytes = dataLength(data);
      bytesDown += bytes;
      target.pause();
      void chargeBytes(bytes)
        .then(() => {
          if (settled) return;
          client.send(data, { binary }, (error) => {
            target.resume();
            if (error) finish("client-error");
          });
        })
        .catch(() => {
          client.close(1008, "Quota exceeded");
          target.terminate();
          finish("quota-exceeded");
        });
    });
    client.once("close", (code, reason) => {
      target.close(code, reason);
      finish("client-closed");
    });
    target.once("close", (code, reason) => {
      client.close(code, reason);
      finish(code === 1000 ? "completed" : "target-closed");
    });
    client.once("error", () => {
      target.terminate();
      finish("client-error");
    });
    target.once("error", () => {
      client.close(1011, "Target connection failed");
      finish("target-error");
    });
  });
