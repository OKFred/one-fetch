import { describe, expect, it } from "vitest";

import type { PolicySetV1 } from "@one-fetch/protocol";

import {
  RECOMMENDED_GLOBAL_BLOCKLIST_V1,
  RECOMMENDED_GLOBAL_BLOCKLIST_WARNINGS_V1,
  createHttpPolicyContext,
  evaluateSystemPolicy,
  ipInCidr,
} from "../src/index.js";

const context = createHttpPolicyContext({
  method: "POST",
  targetOrigin: "https://api.example.com",
  pathAndQuery: "/v1/users?role=admin&role=viewer",
  headers: [
    { name: "X-Tenant", value: "acme" },
    { name: "X-Tenant", value: "backup" },
    { name: "Content-Type", value: "application/json" },
  ],
  fetchOptions: { redirect: "manual", timeoutMs: 60_000 },
  body: {
    availability: "available",
    bytes: new TextEncoder().encode('{"profile":{"enabled":true}}'),
    contentType: "application/json",
  },
});

describe("policy evaluation", () => {
  it("matches path, duplicate query, headers, body, and fetch options", () => {
    const policy: PolicySetV1 = {
      schemaVersion: 1,
      mode: "allowlist",
      revision: 1,
      rules: [
        {
          id: "allow-admin",
          name: "Allow explicit request",
          enabled: true,
          action: "allow",
          match: {
            methods: ["POST"],
            path: {
              representation: "normalized",
              value: { operator: "glob", value: "/v1/*" },
            },
            query: [
              {
                name: { operator: "exact", value: "role" },
                value: { operator: "exact", value: "viewer" },
                presence: "present",
              },
            ],
            headers: [
              {
                name: { operator: "exact", value: "x-tenant" },
                value: { operator: "exact", value: "acme" },
                presence: "present",
              },
            ],
            body: {
              kind: "json",
              pointer: "/profile/enabled",
              operator: "equals",
              value: true,
              onUnavailable: "deny",
            },
            fetchOptions: [
              { option: "redirect", value: "manual", presence: "present" },
            ],
          },
        },
      ],
    };
    expect(evaluateSystemPolicy(policy, context)).toMatchObject({
      decision: "allow",
      ruleId: "allow-admin",
    });
  });

  it("defaults an empty allowlist to deny", () => {
    expect(
      evaluateSystemPolicy(
        { schemaVersion: 1, mode: "allowlist", revision: 0, rules: [] },
        context,
      ),
    ).toEqual({
      decision: "deny",
      source: "default",
      warnings: [],
    });
  });

  it("fails closed when a matching body rule cannot inspect the stream", () => {
    const policy: PolicySetV1 = {
      schemaVersion: 1,
      mode: "blocklist",
      revision: 1,
      rules: [
        {
          id: "inspect",
          name: "Required body inspection",
          enabled: true,
          action: "allow",
          match: {
            body: {
              kind: "text",
              value: { operator: "contains", value: "safe" },
              onUnavailable: "deny",
            },
          },
        },
      ],
    };
    expect(
      evaluateSystemPolicy(policy, {
        ...context,
        body: { availability: "streaming" },
      }),
    ).toMatchObject({
      decision: "deny",
      ruleId: "inspect",
    });
  });

  it("ships an opt-in recommended blocklist covering resolved private addresses", () => {
    expect(
      evaluateSystemPolicy(RECOMMENDED_GLOBAL_BLOCKLIST_V1, {
        ...context,
        resolvedIps: ["169.254.169.254"],
      }),
    ).toMatchObject({
      decision: "deny",
      ruleId: "recommended-private-and-reserved-addresses",
    });
    expect(RECOMMENDED_GLOBAL_BLOCKLIST_WARNINGS_V1.join(" ")).toContain(
      "opt-in template",
    );
  });

  it.each([
    ["recommended-non-https", { scheme: "http" as const }],
    ["recommended-userinfo", { hasUserinfo: true }],
    ["recommended-ip-literal", { hostKind: "ipv4" as const }],
    [
      "recommended-local-and-metadata-hosts",
      { host: "metadata.google.internal" },
    ],
    ["recommended-relay-self", { relaySelf: true }],
  ])("matches recommended template category %s", (ruleId, override) => {
    expect(
      evaluateSystemPolicy(RECOMMENDED_GLOBAL_BLOCKLIST_V1, {
        ...context,
        ...override,
      }),
    ).toMatchObject({
      decision: "deny",
      ruleId,
    });
  });

  it("matches IPv4, IPv6, and IPv4-mapped IPv6 CIDRs", () => {
    expect(ipInCidr("10.1.2.3", "10.0.0.0/8")).toBe(true);
    expect(ipInCidr("fd12::1", "fc00::/7")).toBe(true);
    expect(ipInCidr("::ffff:127.0.0.1", "::ffff:0:0/96")).toBe(true);
    expect(ipInCidr("8.8.8.8", "10.0.0.0/8")).toBe(false);
  });
});
