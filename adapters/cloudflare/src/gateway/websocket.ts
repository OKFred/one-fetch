export interface WebSocketBridgeResult {
  bytesUp: number;
  bytesDown: number;
  code?: number;
  reason?: string;
  clean?: boolean;
  failed: boolean;
}

export async function openTargetWebSocket(
  target: URL,
  headers: Headers,
  signal: AbortSignal,
): Promise<Response> {
  const requestHeaders = new Headers(headers);
  requestHeaders.set("Upgrade", "websocket");
  return fetch(target, {
    method: "GET",
    headers: requestHeaders,
    redirect: "manual",
    signal,
  });
}

export function bridgeWebSockets(
  client: WebSocket,
  target: WebSocket,
  onFinished: (result: WebSocketBridgeResult) => void,
): void {
  let bytesUp = 0;
  let bytesDown = 0;
  let finished = false;

  const finish = (
    result: Omit<WebSocketBridgeResult, "bytesUp" | "bytesDown">,
  ): void => {
    if (finished) return;
    finished = true;
    onFinished({ bytesUp, bytesDown, ...result });
  };

  client.addEventListener(
    "message",
    (event: MessageEvent<string | ArrayBuffer>) => {
      if (finished) return;
      bytesUp += frameBytes(event.data);
      try {
        target.send(event.data);
      } catch {
        safeClose(client, 1011, "Target WebSocket unavailable");
        finish({ failed: true, reason: "target_send_failed" });
      }
    },
  );
  target.addEventListener(
    "message",
    (event: MessageEvent<string | ArrayBuffer>) => {
      if (finished) return;
      bytesDown += frameBytes(event.data);
      try {
        client.send(event.data);
      } catch {
        safeClose(target, 1001, "Client disconnected");
        finish({ failed: true, reason: "client_send_failed" });
      }
    },
  );
  client.addEventListener("close", (event: CloseEvent) => {
    safeClose(target, relayCloseCode(event.code), event.reason);
    finish({
      failed: false,
      code: event.code,
      reason: event.reason,
      clean: event.wasClean,
    });
  });
  target.addEventListener("close", (event: CloseEvent) => {
    safeClose(client, relayCloseCode(event.code), event.reason);
    finish({
      failed: false,
      code: event.code,
      reason: event.reason,
      clean: event.wasClean,
    });
  });
  client.addEventListener("error", () => {
    safeClose(target, 1011, "Client WebSocket error");
    finish({ failed: true, reason: "client_error" });
  });
  target.addEventListener("error", () => {
    safeClose(client, 1011, "Target WebSocket error");
    finish({ failed: true, reason: "target_error" });
  });
}

function frameBytes(value: string | ArrayBuffer): number {
  return typeof value === "string"
    ? new TextEncoder().encode(value).byteLength
    : value.byteLength;
}

function relayCloseCode(code: number): number {
  return code >= 1_000 &&
    code <= 4_999 &&
    code !== 1_004 &&
    code !== 1_005 &&
    code !== 1_006
    ? code
    : 1_000;
}

export function safeClose(
  socket: WebSocket,
  code: number,
  reason: string,
): void {
  try {
    socket.close(code, reason.slice(0, 123));
  } catch {
    // The peer may already be closed.
  }
}
