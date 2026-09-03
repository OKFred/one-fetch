import {
  parseServerTiming,
  responseSetCookies,
  targetHeaders,
} from "../_shared/upstream.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

Deno.test("Server-Timing parsing keeps target metrics separate", () => {
  const metrics = parseServerTiming(
    'db;dur=12.5;desc="primary, read", app;dur=2',
  );
  assert(metrics.length === 2, "expected two metrics");
  assert(
    metrics[0]?.name === "db" && metrics[0].durationMs === 12.5,
    "db timing was not parsed",
  );
});

Deno.test(
  "Request Set-Cookie and transport headers are rejected rather than dropped",
  () => {
    const metadata = {
      protocolVersion: 1 as const,
      requestId: "request-1",
      nonce: "0123456789abcdef0123456789abcdef",
      transport: "http" as const,
      targetOrigin: "https://api.example",
      targetHeaders: [],
      fetchOptions: { redirect: "manual" as const, timeoutMs: 60_000 },
      body: {},
      hop: 0,
    };
    let rejected = false;
    try {
      targetHeaders([{ name: "Set-Cookie", value: "a=b" }], metadata);
    } catch {
      rejected = true;
    }
    assert(rejected, "Set-Cookie request header must be rejected");
  },
);

Deno.test(
  "Multiple Set-Cookie values remain separate when the runtime supports getSetCookie",
  () => {
    const headers = new Headers();
    headers.append("set-cookie", "a=1; Path=/");
    headers.append("set-cookie", "b=2; Path=/");
    assert(
      responseSetCookies(headers).length === 2,
      "Set-Cookie values were merged",
    );
  },
);
