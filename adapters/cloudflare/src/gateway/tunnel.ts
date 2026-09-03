import {
  decodeTunnelClientHello,
  ONE_FETCH_WEBSOCKET_PROTOCOL,
  type OneFetchRequestMetaV1,
} from "@one-fetch/protocol";

import type { AuthorizationResult, ExecutionDecisionInput } from "../types";
import {
  DEFAULT_TUNNEL_DEPENDENCIES,
  type TunnelDependencies,
} from "./tunnel-dependencies";
import { asGatewayProblem, problem } from "./errors";
import {
  buildUpstreamHeaders,
  getSetCookie,
  targetHeaderEntries,
} from "./headers";
import { evaluatePolicies, validateFetchOptions } from "./policy";
import { initialTiming, parseServerTiming } from "./timing";
import { sendTunnelErrorHello, sendTunnelTargetHello } from "./tunnel-response";
import {
  fetchOptionMutations,
  finalizeTunnelBridge,
  mapAuthorizationCode,
  recordTunnelDecisionSafely,
  tunnelCompletion,
} from "./tunnel-support";
import { bridgeWebSockets, safeClose } from "./websocket";

export type { TunnelDependencies } from "./tunnel-dependencies";

export function handleGatewayTunnel(
  request: Request,
  env: CloudflareGatewayEnv,
  ctx: ExecutionContext,
  dependencies: TunnelDependencies = DEFAULT_TUNNEL_DEPENDENCIES,
): Response {
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
    return Response.json(
      { error: "upgrade_required" },
      { status: 426, headers: { Upgrade: "websocket" } },
    );
  }
  const protocols = (request.headers.get("Sec-WebSocket-Protocol") ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (protocols.length !== 1 || protocols[0] !== ONE_FETCH_WEBSOCKET_PROTOCOL) {
    return Response.json({ error: "protocol_unsupported" }, { status: 400 });
  }

  const pair = new WebSocketPair();
  const client = pair[0];
  const server = pair[1];
  server.accept();
  installFirstFrameHandler(server, request, env, ctx, dependencies);
  return new Response(null, {
    status: 101,
    webSocket: client,
    headers: {
      "Sec-WebSocket-Protocol": ONE_FETCH_WEBSOCKET_PROTOCOL,
      "Cache-Control": "no-store",
    },
  });
}

function installFirstFrameHandler(
  socket: WebSocket,
  request: Request,
  env: CloudflareGatewayEnv,
  ctx: ExecutionContext,
  dependencies: TunnelDependencies,
): void {
  let state: "awaiting" | "connecting" | "connected" | "closed" = "awaiting";
  const helloTimer = setTimeout(() => {
    if (state !== "awaiting") return;
    state = "closed";
    safeClose(socket, 1008, "Client hello timeout");
  }, 10_000);

  socket.addEventListener(
    "message",
    (event: MessageEvent<string | ArrayBuffer>) => {
      if (state !== "awaiting") {
        if (state === "connecting") {
          state = "closed";
          safeClose(socket, 1008, "Data sent before server hello");
        }
        return;
      }
      clearTimeout(helloTimer);
      if (typeof event.data !== "string") {
        state = "closed";
        safeClose(socket, 1003, "Client hello must be text");
        return;
      }
      state = "connecting";
      const task = initializeWebSocketTunnel(
        event.data,
        socket,
        request,
        env,
        ctx,
        dependencies,
      )
        .then((connected) => {
          state = connected ? "connected" : "closed";
        })
        .catch(() => {
          state = "closed";
          safeClose(socket, 1011, "Tunnel initialization failed");
        });
      ctx.waitUntil(task);
    },
  );
  socket.addEventListener("close", () => {
    state = "closed";
    clearTimeout(helloTimer);
  });
}

async function initializeWebSocketTunnel(
  rawHello: string,
  clientSocket: WebSocket,
  outerRequest: Request,
  env: CloudflareGatewayEnv,
  ctx: ExecutionContext,
  dependencies: TunnelDependencies,
): Promise<boolean> {
  const startedAt = performance.now();
  let token = "";
  let meta: OneFetchRequestMetaV1 | undefined;
  let authorization: AuthorizationResult | undefined;
  let reportId: string | undefined;
  let abortReason: "timeout" | "cancelled" | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let leaseFinalized = false;

  try {
    const hello = decodeTunnelClientHello(rawHello);
    token = hello.executionToken;
    meta = hello.request;
    reportId = crypto.randomUUID();
    if (meta.transport !== "websocket" || !meta.targetOrigin) {
      throw problem(
        "unsupported_request",
        "protocol",
        "This Cloudflare tunnel entrypoint currently supports WebSocket only",
        400,
      );
    }
    if (meta.hop !== 0)
      throw problem(
        "target_not_allowed",
        "policy",
        "Recursive one-fetch forwarding is denied",
        403,
      );
    if ((meta.body.sizeBytes ?? 0) !== 0 || meta.body.sha256) {
      throw problem(
        "unsupported_request",
        "protocol",
        "WebSocket handshakes cannot include an HTTP body",
        400,
      );
    }
    validateFetchOptions(meta);
    const gatewayUrl = new URL(outerRequest.url);
    const pathAndQuery = `${gatewayUrl.pathname}${gatewayUrl.search}`;
    const target = new URL(pathAndQuery, meta.targetOrigin);
    if (target.origin === gatewayUrl.origin)
      throw problem(
        "target_not_allowed",
        "policy",
        "Recursive gateway requests are denied",
        403,
      );

    const authStartedAt = performance.now();
    authorization = await dependencies.authorize(env.CONTROL, {
      token,
      requestId: meta.requestId,
      transport: "websocket",
      targetUrl: target.toString(),
      method: "GET",
      requestBytes: 0,
    });
    const authMs = performance.now() - authStartedAt;
    if (!authorization.allowed) {
      const code = mapAuthorizationCode(authorization.code);
      throw problem(
        code,
        code === "storage_unavailable"
          ? "storage"
          : code === "quota_exceeded"
            ? "quota"
            : "authorization",
        authorization.message ?? "Tunnel authorization failed",
        code === "storage_unavailable"
          ? 503
          : code === "quota_exceeded"
            ? 429
            : 403,
        code === "storage_unavailable",
      );
    }
    if (
      !authorization.tokenId ||
      !authorization.config ||
      !authorization.configVersion
    ) {
      throw problem(
        "internal",
        "internal",
        "Control service returned an incomplete authorization",
        500,
      );
    }
    const authorizedBase = {
      ...authorization,
      allowed: true as const,
      tokenId: authorization.tokenId,
      config: authorization.config,
      configVersion: authorization.configVersion,
    };

    const policyStartedAt = performance.now();
    const decision = evaluatePolicies({
      meta,
      config: authorizedBase.config,
      method: "GET",
      target,
      gatewayPathAndQuery: pathAndQuery,
      body: {
        availability: "available",
        bytes: new Uint8Array(),
        sizeBytes: 0,
      },
      redirectHops: 0,
      crossOrigin: false,
    });
    const policyMs = performance.now() - policyStartedAt;
    const decisionInput: ExecutionDecisionInput = {
      tokenId: authorizedBase.tokenId,
      requestId: meta.requestId,
      transport: "websocket",
      targetUrl: target.toString(),
      method: "GET",
      requestBytes: 0,
      configVersion: authorizedBase.configVersion,
      headers: meta.targetHeaders.slice(0, 256),
      decision,
    };
    if (decision.decision === "deny") {
      const code =
        decision.source === "user-rule"
          ? "user_rule_denied"
          : "target_not_allowed";
      const auditState = await recordTunnelDecisionSafely(
        dependencies,
        env.CONTROL,
        { ...decisionInput, code },
      );
      authorization = { ...authorizedBase, auditState };
      leaseFinalized = true;
      throw problem(
        code,
        "policy",
        "System or user policy denied the tunnel",
        403,
        false,
        { ruleId: decision.ruleId ?? null },
      );
    }
    const authorized = {
      ...authorizedBase,
      auditState: await recordTunnelDecisionSafely(
        dependencies,
        env.CONTROL,
        decisionInput,
      ),
    };
    authorization = authorized;

    const built = buildUpstreamHeaders(
      meta.targetHeaders,
      meta.fetchOptions.referrer,
    );
    const controller = new AbortController();
    const cancelForClosedClient = (): void => {
      abortReason = "cancelled";
      controller.abort("client_closed");
    };
    clientSocket.addEventListener("close", cancelForClosedClient, {
      once: true,
    });
    if (clientSocket.readyState !== WebSocket.OPEN) cancelForClosedClient();
    outerRequest.signal.addEventListener(
      "abort",
      () => {
        abortReason = "cancelled";
        controller.abort(outerRequest.signal.reason);
      },
      { once: true },
    );
    timer = setTimeout(
      () => {
        abortReason = "timeout";
        controller.abort("timeout");
      },
      Math.min(meta.fetchOptions.timeoutMs, authorized.config.requestTimeoutMs),
    );

    const upstreamStartedAt = performance.now();
    const response = await dependencies.openWebSocket(
      target,
      built.headers,
      controller.signal,
    );
    const upstreamMs = performance.now() - upstreamStartedAt;
    clearTimeout(timer);
    timer = undefined;
    const timing = initialTiming(
      authMs,
      policyMs,
      upstreamMs,
      parseServerTiming(response.headers.get("server-timing")),
    );
    const mutations = [...built.mutations, ...fetchOptionMutations(meta)];
    const handshake = {
      status: response.status,
      statusText: response.statusText,
      headers: targetHeaderEntries(response.headers),
      setCookie: getSetCookie(response.headers),
    };

    if (response.status !== 101 || !response.webSocket) {
      await response.body?.cancel("websocket_rejected");
      await sendTunnelTargetHello({
        socket: clientSocket,
        token,
        requestId: meta.requestId,
        nonce: meta.nonce,
        transport: "websocket",
        target: { state: "rejected", handshake },
        timing,
        configVersion: authorized.configVersion,
        mutations,
        audit: authorized.auditState,
        ...(authorized.auditEventId
          ? { auditEventId: authorized.auditEventId }
          : {}),
        reportId,
      });
      await dependencies.complete(
        env.CONTROL,
        tunnelCompletion(
          authorized.tokenId,
          meta.requestId,
          reportId,
          startedAt,
          0,
          "target",
          response.status,
        ),
      );
      safeClose(clientSocket, 1008, "Target rejected WebSocket upgrade");
      return false;
    }

    response.webSocket.accept();
    await sendTunnelTargetHello({
      socket: clientSocket,
      token,
      requestId: meta.requestId,
      nonce: meta.nonce,
      transport: "websocket",
      target: {
        state: "established",
        handshake,
        ...(response.headers.get("sec-websocket-protocol")
          ? {
              selectedSubprotocol: response.headers.get(
                "sec-websocket-protocol",
              )!,
            }
          : {}),
      },
      timing,
      configVersion: authorized.configVersion,
      mutations,
      audit: authorized.auditState,
      ...(authorized.auditEventId
        ? { auditEventId: authorized.auditEventId }
        : {}),
      reportId,
    });
    const renewalTimer = setInterval(() => {
      ctx.waitUntil(
        dependencies
          .renew(env.CONTROL, authorized.tokenId, meta!.requestId)
          .then((renewed) => {
            if (!renewed) safeClose(clientSocket, 1011, "Tunnel lease expired");
          }),
      );
    }, 30_000);
    bridgeWebSockets(clientSocket, response.webSocket, (result) => {
      clearInterval(renewalTimer);
      ctx.waitUntil(
        finalizeTunnelBridge(
          result,
          dependencies,
          env.CONTROL,
          authorized.tokenId,
          meta!.requestId,
          reportId!,
          startedAt,
        ),
      );
    });
    return true;
  } catch (error) {
    if (timer) clearTimeout(timer);
    let failure = asGatewayProblem(error);
    if (abortReason === "timeout")
      failure = problem(
        "timeout",
        "timeout",
        "The WebSocket handshake exceeded its timeout",
        504,
        true,
      );
    if (abortReason === "cancelled")
      failure = problem(
        "cancelled",
        "cancellation",
        "The client cancelled the tunnel",
        499,
      );
    if (
      authorization?.allowed &&
      authorization.tokenId &&
      meta &&
      reportId &&
      !leaseFinalized
    ) {
      try {
        await dependencies.complete(
          env.CONTROL,
          tunnelCompletion(
            authorization.tokenId,
            meta.requestId,
            reportId,
            startedAt,
            0,
            failure.problem.code === "cancelled" ? "cancelled" : "relay-error",
            undefined,
            failure.problem.code,
          ),
        );
      } catch (completionError) {
        console.error(
          JSON.stringify({
            event: "execution.tunnel-completion.failed",
            error:
              completionError instanceof Error
                ? completionError.message
                : "unknown",
          }),
        );
      }
    }
    if (meta && token) {
      await sendTunnelErrorHello({
        socket: clientSocket,
        token,
        requestId: meta.requestId,
        nonce: meta.nonce,
        problem: failure.problem,
        configVersion: authorization?.configVersion ?? "unknown",
        audit: authorization?.auditState ?? "unknown",
        ...(reportId ? { reportId } : {}),
      }).catch(() => undefined);
    }
    safeClose(
      clientSocket,
      failure.problem.code === "cancelled" ? 1000 : 1008,
      failure.problem.message,
    );
    return false;
  }
}
