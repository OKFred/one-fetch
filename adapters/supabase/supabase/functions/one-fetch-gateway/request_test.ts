import type { ExecutionPrincipal } from "../_shared/auth.ts";
import type { OneFetchRequestMetaV1 } from "../_shared/protocol-types.ts";
import {
  isRecursiveServiceTarget,
  pathAndQuery,
  readRequestBody,
  targetUrl,
  tokenAllows,
} from "./request.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const bases = [
  "https://project.supabase.co/functions/v1/one-fetch-control",
  "https://project.supabase.co/functions/v1/one-fetch-gateway",
];

Deno.test(
  "Provider prefix removal retains repeated slashes and encoded duplicate queries",
  () => {
    for (const path of [
      "//other.example/v1?x=1&x=2",
      "///[path-only]/items?x=%2f&x=+&x=%20",
    ]) {
      const request = new Request(
        `https://project.supabase.co/functions/v1/one-fetch-gateway${path}`,
      );
      const raw = pathAndQuery(request);
      assert(raw === path, "provider prefix changed the target path or query");
      const target = targetUrl("https://target.example", raw);
      assert(
        target.href === `https://target.example${path}`,
        "target origin/path was changed",
      );
    }
  },
);

function principal(
  origins: string[],
  ports: number[] = [],
): ExecutionPrincipal {
  return {
    tokenId: "00000000-0000-4000-8000-000000000001",
    name: "test-token",
    scopes: { transports: ["http"], origins, ports },
    quotas: {
      requestsPerMinute: 60,
      burst: 10,
      concurrentHttp: 4,
      concurrentTunnels: 2,
      bytesPerDay: 1_073_741_824,
    },
  };
}

Deno.test(
  "Recursion checks use the service path, not the whole vendor origin",
  () => {
    assert(
      isRecursiveServiceTarget(
        new URL(
          "https://project.supabase.co/functions/v1/one-fetch-gateway/loop",
        ),
        bases,
      ),
      "gateway recursion was not blocked",
    );
    assert(
      !isRecursiveServiceTarget(
        new URL("https://project.supabase.co/rest/v1/application-data"),
        bases,
      ),
      "unrelated same-project API was overblocked",
    );
  },
);

Deno.test("Execution-token scopes enforce explicit HTTP ports", () => {
  const token = principal(["*"], [443]);
  const metadata = {
    transport: "http",
  } as OneFetchRequestMetaV1;
  assert(
    tokenAllows(token, metadata, new URL("https://api.example")),
    "default HTTPS port should be allowed",
  );
  assert(
    !tokenAllows(token, metadata, new URL("https://api.example:8443")),
    "non-allowed explicit port bypassed token scope",
  );
  token.scopes.ports = [8443];
  assert(
    tokenAllows(token, metadata, new URL("https://api.example:8443")),
    "allowed explicit port was rejected",
  );
});

Deno.test("Execution-token origin scopes are fail-closed", () => {
  const metadata = { transport: "http" } as OneFetchRequestMetaV1;
  const target = new URL("https://api.example/path");
  assert(
    !tokenAllows(principal([]), metadata, target),
    "an empty origin scope must deny every target",
  );
  assert(
    tokenAllows(principal([target.origin]), metadata, target),
    "an exact origin should be allowed",
  );
  assert(
    tokenAllows(principal(["*"]), metadata, target),
    "the explicit wildcard should allow the target",
  );
});

Deno.test(
  "Request-body reads stop when the execution signal aborts",
  async () => {
    const controller = new AbortController();
    const request = new Request("https://gateway.example/upload", {
      method: "POST",
      body: new ReadableStream<Uint8Array>({
        start() {
          // Deliberately leave the stream pending until cancellation.
        },
      }),
    });
    const pending = readRequestBody(
      request,
      { body: {} } as OneFetchRequestMetaV1,
      controller.signal,
    );
    controller.abort("timeout");
    try {
      await pending;
      throw new Error("pending body unexpectedly completed");
    } catch (error) {
      assert(
        error instanceof DOMException && error.message === "timeout",
        "abort reason was not preserved as an Error",
      );
    }
  },
);
