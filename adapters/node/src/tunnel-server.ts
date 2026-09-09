import type { IncomingMessage, Server } from "node:http";
import { performance } from "node:perf_hooks";

import {
  decodeTunnelClientHello,
  ONE_FETCH_LIMITS_V1,
  ONE_FETCH_WEBSOCKET_PROTOCOL,
  type OneFetchProblemV1,
  type OneFetchRequestMetaV1,
  type OneFetchTimingV1,
} from "@one-fetch/protocol";
import WebSocket, { WebSocketServer } from "ws";

import { GatewayFailure, failure } from "./gateway-error.js";
import type { GatewayDependencies } from "./gateway.js";
import { validateTargetHeaders } from "./headers.js";
import type { QuotaLease } from "./quota.js";
import { auditTunnelAccepted, auditTunnelClosed } from "./tunnel-audit.js";
import { tunnelDataToText } from "./tunnel-data.js";
import { approveTunnelTarget } from "./tunnel-policy.js";
import {
  signTunnelError,
  signTunnelTarget,
  type TunnelResponseContext,
} from "./tunnel-response.js";
import {
  bridgeSocketTunnel,
  connectSocketTarget,
  type TunnelTransferResult,
} from "./tunnel-socket.js";
import {
  bridgeWebSockets,
  connectWebSocketTarget,
} from "./tunnel-websocket.js";

const closeWithMessage = (
  socket: WebSocket,
  code: number,
  message: string,
): void => {
  if (socket.readyState === WebSocket.OPEN) socket.close(code, message);
  else socket.terminate();
};

const sendThenClose = (
  socket: WebSocket,
  payload: string,
  code: number,
  message: string,
): Promise<void> =>
  new Promise((resolve) => {
    socket.send(payload, (error) => {
      if (error) socket.terminate();
      else closeWithMessage(socket, code, message);
      resolve();
    });
  });

const firstHello = (
  socket: WebSocket,
): Promise<ReturnType<typeof decodeTunnelClientHello>> =>
  new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(failure("timeout", "timeout", "Tunnel hello timed out", 408));
    }, ONE_FETCH_LIMITS_V1.timeoutMs);
    const cleanup = () => {
      clearTimeout(timeout);
      socket.off("close", onClose);
      socket.off("error", onError);
      socket.off("message", onMessage);
    };
    const onClose = () => {
      cleanup();
      reject(failure("cancelled", "cancellation", "Client closed", 499));
    };
    const onError = () => {
      cleanup();
      reject(failure("cancelled", "cancellation", "Client failed", 499));
    };
    const onMessage = (data: WebSocket.RawData, binary: boolean) => {
      cleanup();
      if (binary) {
        reject(
          failure(
            "invalid_metadata",
            "protocol",
            "Tunnel client hello must be a text frame",
            400,
          ),
        );
        return;
      }
      socket.pause();
      try {
        resolve(decodeTunnelClientHello(tunnelDataToText(data)));
      } catch (error) {
        reject(
          failure(
            error instanceof Error && error.message.includes("maximum")
              ? "metadata_too_large"
              : "invalid_metadata",
            "protocol",
            "Tunnel client hello is invalid",
            400,
          ),
        );
      }
    };
    socket.once("close", onClose);
    socket.once("error", onError);
    socket.once("message", onMessage);
  });

const validateTunnelRequest = (metadata: OneFetchRequestMetaV1): void => {
  if (metadata.transport === "http")
    throw failure(
      "unsupported_request",
      "protocol",
      "Tunnel listener does not accept HTTP transport",
      400,
    );
  if (metadata.body.sizeBytes && metadata.body.sizeBytes > 0)
    throw failure(
      "unsupported_request",
      "protocol",
      "Tunnel hello cannot carry an HTTP request body",
      400,
    );
  if (metadata.fetchOptions.timeoutMs > ONE_FETCH_LIMITS_V1.timeoutMs)
    throw failure(
      "unsupported_option",
      "protocol",
      "Tunnel timeout exceeds the adapter maximum",
      400,
    );
  if (metadata.transport !== "websocket" && metadata.targetHeaders.length > 0)
    throw failure(
      "unsupported_header",
      "protocol",
      "TCP and TLS tunnels do not accept HTTP headers",
      400,
    );
  const unsafeHeader = validateTargetHeaders(metadata.targetHeaders);
  if (unsafeHeader)
    throw failure(
      "unsupported_header",
      "protocol",
      `Header ${unsafeHeader} cannot be forwarded`,
      400,
    );
};

const problemFrom = (error: unknown, aborted: boolean): OneFetchProblemV1 => {
  if (error instanceof GatewayFailure) return error.problem;
  return {
    code: aborted ? "timeout" : "upstream_network",
    message: aborted ? "Tunnel connection timed out" : "Tunnel setup failed",
    origin: "one-fetch",
    retryable: !aborted,
    stage: aborted ? "timeout" : "connect",
  };
};

const handleTunnel = async (
  socket: WebSocket,
  request: IncomingMessage,
  dependencies: GatewayDependencies,
): Promise<void> => {
  const startedAt = Date.now();
  let metadata: OneFetchRequestMetaV1 | undefined;
  let token = "";
  let context: TunnelResponseContext | undefined;
  let quotaLease: QuotaLease | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const abort = new AbortController();
  try {
    const hello = await firstHello(socket);
    metadata = hello.request;
    token = hello.executionToken;
    validateTunnelRequest(metadata);
    const configuration = await dependencies.configuration.get();
    context = {
      auditState: "unknown",
      configVersion: configuration.version,
      metadata,
      token,
    };
    const credential = await dependencies.auth.authenticateExecution(token);
    if (!credential)
      throw failure(
        "unauthorized",
        "authentication",
        "Execution token is invalid",
        401,
      );
    if (configuration.gatewayPaused)
      throw failure(
        "forbidden",
        "policy",
        "Gateway is paused by the administrator",
        503,
        true,
      );
    quotaLease = await dependencies.quota.acquire(credential, "tunnel");
    timeout = setTimeout(
      () => abort.abort(new Error("Tunnel setup timeout")),
      metadata.fetchOptions.timeoutMs,
    );
    socket.once("close", () => abort.abort(new Error("Client cancelled")));
    const target = await approveTunnelTarget(
      metadata,
      credential,
      configuration,
      dependencies.config,
      request.url ?? "/",
    );
    context.auditState = await auditTunnelAccepted(
      dependencies,
      metadata,
      credential,
      configuration,
      request.url ?? "/",
    );
    const timing: OneFetchTimingV1 = {
      phases: [
        {
          durationMs: target.resolution.dnsDurationMs,
          name: "dns",
          source: "gateway",
          state: "measured",
        },
      ],
      serverTiming: [],
    };
    const connectedAt = performance.now();
    let transfer: Promise<TunnelTransferResult>;
    if (metadata.transport === "websocket") {
      const upstream = await connectWebSocketTarget(
        metadata,
        target,
        abort.signal,
      );
      timing.phases.push({
        durationMs: performance.now() - connectedAt,
        name: "connect",
        source: "gateway",
        state: "measured",
      });
      if (upstream.state === "rejected") {
        const payload = await signTunnelTarget(
          context,
          {
            handshake: upstream.handshake,
            kind: "tunnel",
            state: "rejected",
            transport: "websocket",
          },
          timing,
        );
        socket.resume();
        await sendThenClose(socket, payload, 1008, "Target rejected upgrade");
        return;
      }
      const payload = await signTunnelTarget(
        context,
        {
          handshake: upstream.handshake,
          kind: "tunnel",
          selectedSubprotocol: upstream.socket.protocol || undefined,
          state: "established",
          transport: "websocket",
        },
        timing,
      );
      await new Promise<void>((resolve, reject) =>
        socket.send(payload, (error) => (error ? reject(error) : resolve())),
      );
      transfer = bridgeWebSockets(
        socket,
        upstream.socket,
        quotaLease.chargeBytes,
      );
    } else {
      const upstream = await connectSocketTarget(
        metadata,
        target,
        abort.signal,
      );
      timing.phases.push({
        durationMs: performance.now() - connectedAt,
        name: metadata.transport === "tls" ? "tls" : "connect",
        source: "gateway",
        state: "measured",
      });
      const payload = await signTunnelTarget(
        context,
        {
          kind: "tunnel",
          state: "established",
          transport: metadata.transport === "tls" ? "tls" : "tcp",
        },
        timing,
      );
      await new Promise<void>((resolve, reject) =>
        socket.send(payload, (error) => (error ? reject(error) : resolve())),
      );
      transfer = bridgeSocketTunnel(socket, upstream, quotaLease.chargeBytes);
    }
    if (timeout) clearTimeout(timeout);
    timeout = undefined;
    socket.resume();
    const result = await transfer;
    await auditTunnelClosed(
      dependencies,
      metadata,
      credential,
      startedAt,
      result.bytesUp,
      result.bytesDown,
      result.reason,
    );
  } catch (error) {
    socket.resume();
    if (context) {
      const payload = await signTunnelError(
        context,
        problemFrom(error, abort.signal.aborted),
      );
      await sendThenClose(socket, payload, 1008, "Tunnel setup rejected");
    } else {
      closeWithMessage(socket, 1002, "Invalid tunnel hello");
    }
  } finally {
    if (timeout) clearTimeout(timeout);
    await quotaLease?.release();
  }
};

const rejectUpgrade = (request: IncomingMessage): boolean => {
  const requested: string | string[] | undefined =
    request.headers["sec-websocket-protocol"];
  const requestedValues: string[] = Array.isArray(requested)
    ? requested
    : [requested ?? ""];
  const values = requestedValues
    .flatMap((value) => value.split(","))
    .map((value) => value.trim());
  return !values.includes(ONE_FETCH_WEBSOCKET_PROTOCOL);
};

export const attachTunnelServer = (
  server: Server,
  dependencies: GatewayDependencies,
): void => {
  const tunnels = new WebSocketServer({
    handleProtocols: (protocols) =>
      protocols.has(ONE_FETCH_WEBSOCKET_PROTOCOL)
        ? ONE_FETCH_WEBSOCKET_PROTOCOL
        : false,
    maxPayload: ONE_FETCH_LIMITS_V1.responseBodyBytes,
    noServer: true,
  });
  tunnels.on("connection", (socket, request) => {
    void handleTunnel(socket, request, dependencies);
  });
  server.on("upgrade", (request, socket, head) => {
    if (rejectUpgrade(request)) {
      socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
      return;
    }
    tunnels.handleUpgrade(request, socket, head, (websocket) => {
      tunnels.emit("connection", websocket, request);
    });
  });
  server.once("close", () => tunnels.close());
};
