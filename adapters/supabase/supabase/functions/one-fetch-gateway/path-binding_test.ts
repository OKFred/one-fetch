import {
  decodeResponseMetadata,
  ONE_FETCH_RESPONSE_HEADER,
} from "@one-fetch/protocol";
import type { JsonValue } from "../_shared/protocol-types.ts";
import { verifySignedResponseMetadata } from "@one-fetch/core";
import { SUPABASE_FETCH_OPTIONS } from "../_shared/capabilities.ts";
import { OneFetchGatewayClient } from "../../../../../packages/client/dist/index.js";
import { HTTP_CONFORMANCE_FIXTURES } from "../../../../../packages/conformance/dist/fixtures.js";
import { runGatewayConformance } from "../../../../../packages/conformance/dist/runner.js";
import { handleConformanceTarget } from "../../../../../packages/conformance/dist/target.js";
import {
  boundPathRequest,
  pathHarness,
  pathToken,
  targetOrigin,
} from "./path-test-support.ts";

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

Deno.test(
  "shared HTTP smoke fixtures survive simulated hosted ingress normalization",
  async () => {
    const { handler, environment, events } = await pathHarness();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (input, init) => {
      const request = new Request(input, init);
      assert(
        new URL(request.url).origin === targetOrigin,
        "binding replaced the target authority",
      );
      return handleConformanceTarget(request);
    };
    try {
      const client = new OneFetchGatewayClient({
        gatewayUrl: environment.gatewayBaseUrl,
        token: pathToken,
        capabilities: SUPABASE_FETCH_OPTIONS,
        fetch: (input: RequestInfo | URL, init?: RequestInit) => {
          const url = new URL(input instanceof Request ? input.url : input);
          url.pathname = url.pathname.replace(/\/{2,}/gu, "/");
          // Smoke fixtures use key=value fields. Recorded ingress vectors in
          // path-query_test.ts separately cover bare flags and punctuation.
          url.search = url.searchParams.toString();
          const normalized = url.href.replace(/%[\da-f]{2}/giu, (escape) =>
            escape.toUpperCase(),
          );
          return handler(new Request(normalized, init));
        },
      });
      const report = await runGatewayConformance(
        client,
        targetOrigin,
        HTTP_CONFORMANCE_FIXTURES,
      );
      assert(
        report.passed,
        JSON.stringify(report.results.filter((result) => !result.passed)),
      );
      const received = events.filter(
        (event) => event.action === "execution.received",
      );
      assert(
        received.some(
          (event) => (event.request as { path?: string }).path === "//v1/echo",
        ),
        "audit lost the bound original path",
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  },
);

Deno.test(
  "missing and forged path bindings are signed denials before quota or upstream",
  async () => {
    const originalFetch = globalThis.fetch;
    let upstreamCalls = 0;
    globalThis.fetch = () => {
      upstreamCalls += 1;
      throw new Error("unexpected upstream");
    };
    try {
      const values: Array<JsonValue | undefined> = [
        undefined,
        "/other",
        { path: "/echo" },
        "https://evil.example/echo",
        "/echo#secret",
        "/echo?x=%2f",
      ];
      for (const binding of values) {
        const { handler, environment, calls, events } = await pathHarness();
        const response = await handler(
          boundPathRequest(environment.gatewayBaseUrl, "/echo", binding),
        );
        const signed = decodeResponseMetadata(
          response.headers.get(ONE_FETCH_RESPONSE_HEADER) ?? "",
        );
        assert(
          signed.outcome === "relay-error",
          "bad binding became a target result",
        );
        assert(
          signed.error?.code ===
            (binding === undefined ? "unsupported_option" : "invalid_metadata"),
          "unexpected denial code",
        );
        assert(
          await verifySignedResponseMetadata(signed, {
            token: pathToken,
            requestId: signed.requestId,
            nonce: signed.nonce,
          }),
          "denial signature invalid",
        );
        assert(
          !calls.includes("of_acquire_execution"),
          "invalid binding acquired quota",
        );
        assert(
          events.some((event) => event.action === "execution.protocol-denied"),
          "missing denial audit",
        );
      }
      assert(upstreamCalls === 0, "invalid binding reached upstream");
    } finally {
      globalThis.fetch = originalFetch;
    }
  },
);

Deno.test(
  "system path policy uses the bound original, not the normalized wire path",
  async () => {
    const { handler, environment } = await pathHarness({
      schemaVersion: 1,
      mode: "blocklist",
      revision: 1,
      rules: [
        {
          id: "deny-original",
          name: "Deny original path",
          enabled: true,
          action: "deny",
          match: {
            path: {
              representation: "raw",
              value: { operator: "exact", value: "//protected" },
            },
          },
        },
      ],
    });
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = () => {
      calls += 1;
      throw new Error("unexpected upstream");
    };
    try {
      const response = await handler(
        boundPathRequest(
          environment.gatewayBaseUrl,
          "/protected",
          "//protected",
        ),
      );
      const signed = decodeResponseMetadata(
        response.headers.get(ONE_FETCH_RESPONSE_HEADER) ?? "",
      );
      assert(
        signed.error?.code === "target_not_allowed",
        "raw path policy was bypassed",
      );
      assert(calls === 0, "denied original path reached upstream");
    } finally {
      globalThis.fetch = originalFetch;
    }
  },
);

Deno.test(
  "bound sensitive query values remain redacted from audit and execution reports",
  async () => {
    const { handler, environment, events, reports, waitForReport } =
      await pathHarness();
    const originalFetch = globalThis.fetch;
    const secret = "synthetic-path-secret-canary";
    globalThis.fetch = () => Promise.resolve(new Response("synthetic"));
    try {
      const response = await handler(
        boundPathRequest(
          environment.gatewayBaseUrl,
          `/echo?token=${secret}+suffix`,
          `//echo?token=${secret}%20suffix`,
        ),
      );
      await response.text();
      await waitForReport();
      assert(reports.length === 1, "completion report was not persisted");
      const stored = JSON.stringify({ events, reports });
      assert(
        !stored.includes(secret),
        "path binding leaked a secret into persistence",
      );
      assert(
        !stored.includes("supabaseOriginalPathV1"),
        "unredacted adapter metadata was persisted",
      );
      assert(stored.includes("[REDACTED]"), "sensitive query was not redacted");
    } finally {
      globalThis.fetch = originalFetch;
    }
  },
);

Deno.test("user deny rules also evaluate the bound original path", async () => {
  const { handler, environment } = await pathHarness();
  const originalFetch = globalThis.fetch;
  let upstreamCalls = 0;
  globalThis.fetch = () => {
    upstreamCalls += 1;
    throw new Error("unexpected upstream");
  };
  try {
    const response = await handler(
      boundPathRequest(
        environment.gatewayBaseUrl,
        "/protected",
        "//protected",
        {
          userDenyRules: {
            schemaVersion: 1,
            rules: [
              {
                id: "user-path-deny",
                name: "User path deny",
                enabled: true,
                action: "deny",
                match: {
                  path: {
                    representation: "raw",
                    value: { operator: "exact", value: "//protected" },
                  },
                },
              },
            ],
          },
        },
      ),
    );
    const signed = decodeResponseMetadata(
      response.headers.get(ONE_FETCH_RESPONSE_HEADER) ?? "",
    );
    assert(signed.error?.code === "user_rule_denied", "user rule was bypassed");
    assert(upstreamCalls === 0, "user-denied path reached upstream");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("ingress binding is not reapplied to a target redirect", async () => {
  const { handler, environment } = await pathHarness();
  const originalFetch = globalThis.fetch;
  const paths: string[] = [];
  globalThis.fetch = (input) => {
    const url = new URL(input instanceof Request ? input.url : input);
    paths.push(`${url.pathname}${url.search}`);
    return Promise.resolve(
      paths.length === 1
        ? new Response(null, {
            status: 302,
            headers: { location: "/next//echo?x=%2f" },
          })
        : new Response("redirected"),
    );
  };
  try {
    const response = await handler(
      boundPathRequest(
        environment.gatewayBaseUrl,
        "/start?x=%2F",
        "//start?x=%2f",
        { redirect: "follow" },
      ),
    );
    assert(
      (await response.text()) === "redirected",
      "redirect did not complete",
    );
    assert(
      JSON.stringify(paths) ===
        JSON.stringify(["//start?x=%2f", "/next//echo?x=%2f"]),
      "initial binding replaced a subsequent redirect path",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
