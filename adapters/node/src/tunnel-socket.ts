import { connect as connectTcp, type Socket } from "node:net";
import { connect as connectTls, type TLSSocket } from "node:tls";

import type { OneFetchRequestMetaV1 } from "@one-fetch/protocol";
import type WebSocket from "ws";

import { tunnelDataToBuffer } from "./tunnel-data.js";
import type { ApprovedTunnelTarget } from "./tunnel-policy.js";

export interface TunnelTransferResult {
  bytesDown: number;
  bytesUp: number;
  reason: string;
}

export type TunnelByteGate = (bytes: number) => Promise<void>;

const allowAllBytes: TunnelByteGate = () => Promise.resolve();

export const connectSocketTarget = async (
  metadata: OneFetchRequestMetaV1,
  target: ApprovedTunnelTarget,
  signal: AbortSignal,
): Promise<Socket | TLSSocket> => {
  const authority = metadata.targetAuthority!;
  const adapter = metadata.fetchOptions.adapter ?? {};
  const socket =
    metadata.transport === "tls"
      ? connectTls({
          ALPNProtocols: authority.alpn,
          ca: typeof adapter.caPem === "string" ? adapter.caPem : undefined,
          cert:
            typeof adapter.clientCertificatePem === "string"
              ? adapter.clientCertificatePem
              : undefined,
          host: target.resolution.address,
          key:
            typeof adapter.clientPrivateKeyPem === "string"
              ? adapter.clientPrivateKeyPem
              : undefined,
          port: target.port,
          rejectUnauthorized: adapter.rejectUnauthorized !== false,
          servername: authority.sni ?? authority.host,
        })
      : connectTcp({
          family: target.resolution.family,
          host: target.resolution.address,
          port: target.port,
        });

  const event = metadata.transport === "tls" ? "secureConnect" : "connect";
  return new Promise((resolve, reject) => {
    const abort = () => socket.destroy(signal.reason as Error | undefined);
    const cleanup = () => {
      signal.removeEventListener("abort", abort);
      socket.off("error", reject);
    };
    signal.addEventListener("abort", abort, { once: true });
    socket.once("error", reject);
    socket.once(event, () => {
      cleanup();
      resolve(socket);
    });
  });
};

export const bridgeSocketTunnel = (
  client: WebSocket,
  target: Socket | TLSSocket,
  chargeBytes: TunnelByteGate = allowAllBytes,
): Promise<TunnelTransferResult> =>
  new Promise((resolve) => {
    let bytesUp = 0;
    let bytesDown = 0;
    let settled = false;
    const finish = (reason: string) => {
      if (settled) return;
      settled = true;
      client.off("message", onClientMessage);
      target.removeAllListeners("data");
      resolve({ bytesDown, bytesUp, reason });
    };
    const onClientMessage = (data: WebSocket.RawData, binary: boolean) => {
      if (!binary) {
        client.close(1003, "TCP and TLS tunnels require binary frames");
        target.destroy();
        finish("non-binary-frame");
        return;
      }
      const bytes = tunnelDataToBuffer(data);
      bytesUp += bytes.byteLength;
      client.pause();
      void chargeBytes(bytes.byteLength)
        .then(() => {
          if (settled) return;
          if (target.write(bytes)) client.resume();
        })
        .catch(() => {
          client.close(1008, "Quota exceeded");
          target.destroy();
          finish("quota-exceeded");
        });
    };
    client.on("message", onClientMessage);
    client.once("close", () => {
      target.destroy();
      finish("client-closed");
    });
    client.once("error", () => {
      target.destroy();
      finish("client-error");
    });
    target.on("drain", () => client.resume());
    target.on("data", (chunk: Buffer) => {
      bytesDown += chunk.byteLength;
      target.pause();
      void chargeBytes(chunk.byteLength)
        .then(() => {
          if (settled) return;
          client.send(chunk, { binary: true }, (error) => {
            if (error) {
              target.destroy(error);
              finish("client-error");
            } else {
              target.resume();
            }
          });
        })
        .catch(() => {
          client.close(1008, "Quota exceeded");
          target.destroy();
          finish("quota-exceeded");
        });
    });
    target.once("end", () => {
      client.close(1000, "Target closed");
      finish("completed");
    });
    target.once("error", () => {
      client.close(1011, "Target connection failed");
      finish("target-error");
    });
    target.once("close", () => finish("target-closed"));
  });
