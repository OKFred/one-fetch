import { classifyOneFetchResponse } from "@one-fetch/core";
import {
  ONE_FETCH_RESPONSE_HEADER,
  ExecutionReportV1Schema,
} from "@one-fetch/protocol";
import { bytesToBase64Url } from "../_shared/crypto.ts";
import type { GatewayContext } from "./foundation.ts";
import { createTargetResponse } from "./target-response.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function fixture(envelope: boolean) {
  const keys = await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ]);
  const key = "privateKey" in keys ? keys.privateKey : keys;
  const complete = Promise.withResolvers<Record<string, unknown>>();
  const context: GatewayContext = {
    environment: {
      instanceId: crypto.randomUUID(),
      bootstrapSecret: "b".repeat(32),
      pepper: "p".repeat(32),
      auditSigningPrivateKey: bytesToBase64Url(
        new Uint8Array(await crypto.subtle.exportKey("pkcs8", key)),
      ),
      auditKeyId: "fixture",
      supabaseUrl: "https://fixture.supabase.co",
      serviceRoleKey: "synthetic",
      controlBaseUrl:
        "https://fixture.supabase.co/functions/v1/one-fetch-control",
      gatewayBaseUrl:
        "https://fixture.supabase.co/functions/v1/one-fetch-gateway",
      allowedAdminOrigins: [],
      allowedClientOrigins: [],
      buildVersion: "test",
    },
    database: {
      rpc: <T>(name: string, parameters: Record<string, unknown> = {}) => {
        assert(name === "of_finalize_execution", "Unexpected RPC");
        complete.resolve(parameters);
        return Promise.resolve({
          status: "finalized",
          auditState: "recorded",
        } as T);
      },
    },
    token: "of_synthetic_browser_response_secret",
    principal: {
      tokenId: crypto.randomUUID(),
      name: "fixture",
      scopes: {
        transports: ["http"],
        origins: ["https://target.example"],
        ports: [],
      },
      quotas: {
        requestsPerMinute: 60,
        burst: 10,
        concurrentHttp: 4,
        concurrentTunnels: 2,
        bytesPerDay: 1_073_741_824,
      },
    },
    metadata: {
      protocolVersion: 1,
      requestId: crypto.randomUUID(),
      nonce: "0123456789abcdef0123456789abcdef",
      transport: "http",
      targetOrigin: "https://target.example",
      targetHeaders: [],
      fetchOptions: {
        redirect: "manual",
        timeoutMs: 60_000,
        ...(envelope ? { adapter: { browserResponse: "envelope-v1" } } : {}),
      },
      body: {},
      hop: 0,
    },
    configVersion: "config-test",
    startedAt: performance.now(),
    requestMethod: "GET",
    targetPathAndQuery: "/status",
  };
  return { context, complete: complete.promise };
}

for (const envelope of [false, true]) {
  for (const status of [201, 204, 205, 302, 304, 404, 503]) {
    Deno.test(
      `Supabase target ${status} with browser envelope=${envelope}`,
      async () => {
        const { context, complete } = await fixture(envelope);
        const empty = [204, 205, 304].includes(status);
        const headers = new Headers({
          Location: "/next",
          "Content-Type": "text/html",
          "Content-Security-Policy": "sandbox",
        });
        headers.append("Set-Cookie", "a=1; Secure");
        headers.append("Set-Cookie", "b=2; Secure");
        const timeout = setTimeout(() => {
          throw new Error("Fixture timeout");
        }, 5_000);
        try {
          const response = await createTargetResponse({
            request: new Request("https://gateway.example/status"),
            context,
            upstream: new Response(empty ? null : "abc", { status, headers }),
            leaseId: crypto.randomUUID(),
            abortController: new AbortController(),
            didTimeOut: () => false,
            timeout,
            auditState: "recorded",
            ttfbMs: 2,
          });
          assert(
            response.status === (envelope ? 200 : status),
            "Wrong transport status",
          );
          assert(
            !response.headers.has("set-cookie"),
            "Set-Cookie leaked onto Gateway",
          );
          if (envelope) {
            assert(
              !response.headers.has("location"),
              "Location leaked onto Gateway",
            );
            assert(
              !response.headers.has("content-security-policy"),
              "CSP leaked onto Gateway",
            );
          }
          const classified = await classifyOneFetchResponse(
            response.headers.get(ONE_FETCH_RESPONSE_HEADER),
            {
              token: context.token,
              requestId: context.metadata.requestId,
              nonce: context.metadata.nonce,
            },
          );
          assert(
            classified.source === "target" && classified.target.kind === "http",
            "Not a signed HTTP target",
          );
          assert(classified.target.status === status, "Target status changed");
          assert(classified.target.setCookie.length === 2, "Cookies merged");
          assert(
            classified.metadata.responseMode ===
              (envelope ? "browser-envelope-v1" : undefined),
            "Wrong signed mode",
          );
          assert(
            (await response.text()) === (empty ? "" : "abc"),
            "Body changed",
          );
          const record = await complete;
          const report = ExecutionReportV1Schema.parse(record.p_report);
          assert(report.status === status, "Report bound to transport status");
          assert(
            report.bodyComplete &&
              report.bodySha256 ===
                (empty
                  ? "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
                  : "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"),
            "Wrong body digest",
          );
        } finally {
          clearTimeout(timeout);
        }
      },
    );
  }
}
