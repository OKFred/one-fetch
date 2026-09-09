import {
  PolicySetV1Schema,
  UserDenyRulesV1Schema,
  type FetchOptionsV1,
  type HeaderEntryV1,
  type PolicyRuleV1,
  type PolicySetV1,
  type UserDenyRulesV1,
} from "@one-fetch/protocol";

import { ipInCidr, isIpLiteral } from "./ip.js";
import {
  matchNamedValue,
  matchPolicyBody,
  matchString,
  type BodyMatchResult,
} from "./policy-matchers.js";
import type {
  PolicyBodyContext,
  PolicyDecision,
  PolicyRequestContext,
} from "./policy-types.js";

function getFetchOption(options: FetchOptionsV1, path: string): unknown {
  if (path.startsWith("adapter."))
    return options.adapter?.[path.slice("adapter.".length)];
  return options[path as keyof FetchOptionsV1];
}

function matchRule(
  rule: PolicyRuleV1,
  context: PolicyRequestContext,
): BodyMatchResult {
  const match = rule.match;
  const tests: boolean[] = [];
  if (match.transports !== undefined)
    tests.push(match.transports.includes(context.transport));
  if (match.methods !== undefined)
    tests.push(
      context.method !== undefined &&
        match.methods.some(
          (method) => method.toUpperCase() === context.method!.toUpperCase(),
        ),
    );
  if (match.schemes !== undefined)
    tests.push(
      context.scheme !== undefined && match.schemes.includes(context.scheme),
    );
  if (match.hasUserinfo !== undefined)
    tests.push((context.hasUserinfo ?? false) === match.hasUserinfo);
  if (match.hostKinds !== undefined)
    tests.push(
      context.hostKind !== undefined &&
        match.hostKinds.includes(context.hostKind),
    );
  if (match.resolvedIpCidrs !== undefined)
    tests.push(
      context.resolvedIps !== undefined &&
        context.resolvedIps.some((address) =>
          match.resolvedIpCidrs!.some((cidr) => ipInCidr(address, cidr)),
        ),
    );
  if (match.relaySelf !== undefined)
    tests.push((context.relaySelf ?? false) === match.relaySelf);
  if (match.origins !== undefined)
    tests.push(
      context.origin !== undefined &&
        match.origins.some((matcher) =>
          matchString(matcher, context.origin!, true),
        ),
    );
  if (match.hosts !== undefined)
    tests.push(
      context.host !== undefined &&
        match.hosts.some((matcher) =>
          matchString(matcher, context.host!, true),
        ),
    );
  if (match.ports !== undefined)
    tests.push(
      context.port !== undefined && match.ports.includes(context.port),
    );
  if (match.path !== undefined) {
    const value =
      match.path.representation === "raw"
        ? context.rawPath
        : context.normalizedPath;
    tests.push(value !== undefined && matchString(match.path.value, value));
  }
  if (match.query !== undefined)
    tests.push(
      match.query.every((matcher) =>
        matchNamedValue(matcher, context.query, false),
      ),
    );
  if (match.headers !== undefined)
    tests.push(
      match.headers.every((matcher) =>
        matchNamedValue(
          matcher,
          context.headers.map(({ name, value }) => [name, value]),
          true,
        ),
      ),
    );
  if (match.fetchOptions !== undefined) {
    tests.push(
      match.fetchOptions.every((matcher) => {
        const value = getFetchOption(context.fetchOptions, matcher.option);
        if (matcher.presence === "absent") return value === undefined;
        return (
          value !== undefined &&
          (matcher.value === undefined ||
            JSON.stringify(value) === JSON.stringify(matcher.value))
        );
      }),
    );
  }
  if (match.redirect !== undefined)
    tests.push(
      context.redirect !== undefined &&
        (match.redirect.minHops === undefined ||
          context.redirect.hops >= match.redirect.minHops) &&
        (match.redirect.maxHops === undefined ||
          context.redirect.hops <= match.redirect.maxHops) &&
        (match.redirect.crossOrigin === undefined ||
          context.redirect.crossOrigin === match.redirect.crossOrigin),
    );
  if (match.websocketSubprotocols !== undefined)
    tests.push(
      context.websocketSubprotocols !== undefined &&
        match.websocketSubprotocols.every((matcher) =>
          context.websocketSubprotocols!.some((value) =>
            matchString(matcher, value),
          ),
        ),
    );
  if (match.sni !== undefined)
    tests.push(
      context.sni !== undefined && matchString(match.sni, context.sni, true),
    );
  if (match.alpn !== undefined)
    tests.push(
      context.alpn !== undefined &&
        match.alpn.every((matcher) =>
          context.alpn!.some((value) => matchString(matcher, value)),
        ),
    );
  if (tests.some((value) => !value))
    return { matches: false, unavailableDeny: false };
  if (match.body !== undefined)
    return matchPolicyBody(match.body, context.body);
  return { matches: true, unavailableDeny: false };
}

function decisionFromRules(
  rules: readonly PolicyRuleV1[],
  context: PolicyRequestContext,
  source: "system-rule" | "user-rule",
): PolicyDecision | undefined {
  for (const rule of rules) {
    if (!rule.enabled) continue;
    const result = matchRule(rule, context);
    if (result.unavailableDeny)
      return {
        decision: "deny",
        source,
        ruleId: rule.id,
        warnings: result.warning === undefined ? [] : [result.warning],
      };
    if (result.matches)
      return {
        decision: rule.action,
        source,
        ruleId: rule.id,
        warnings: result.warning === undefined ? [] : [result.warning],
      };
  }
  return undefined;
}

export function evaluateSystemPolicy(
  policy: PolicySetV1,
  context: PolicyRequestContext,
): PolicyDecision {
  const parsed = PolicySetV1Schema.parse(policy);
  return (
    decisionFromRules(parsed.rules, context, "system-rule") ?? {
      decision: parsed.mode === "allowlist" ? "deny" : "allow",
      source: "default",
      warnings: [],
    }
  );
}

export function evaluateUserDenyRules(
  rules: UserDenyRulesV1 | undefined,
  context: PolicyRequestContext,
): PolicyDecision {
  if (rules === undefined)
    return { decision: "allow", source: "default", warnings: [] };
  const parsed = UserDenyRulesV1Schema.parse(rules);
  return (
    decisionFromRules(parsed.rules, context, "user-rule") ?? {
      decision: "allow",
      source: "default",
      warnings: [],
    }
  );
}

export function createHttpPolicyContext(input: {
  method: string;
  targetOrigin: string;
  pathAndQuery: string;
  headers: HeaderEntryV1[];
  fetchOptions: FetchOptionsV1;
  body?: PolicyBodyContext;
  transport?: "http" | "websocket";
  hasUserinfo?: boolean;
  resolvedIps?: string[];
  relaySelf?: boolean;
}): PolicyRequestContext {
  if (!input.pathAndQuery.startsWith("/")) {
    throw new TypeError("pathAndQuery must start with /");
  }
  const origin = new URL(input.targetOrigin);
  const pathUrl = new URL(input.pathAndQuery, origin);
  const rawPath = input.pathAndQuery.split("?", 1)[0] ?? "/";
  return {
    transport: input.transport ?? "http",
    method: input.method,
    scheme:
      input.transport === "websocket"
        ? origin.protocol === "https:"
          ? "wss"
          : "ws"
        : origin.protocol === "https:"
          ? "https"
          : "http",
    hasUserinfo: input.hasUserinfo ?? false,
    hostKind: isIpLiteral(origin.hostname)
      ? origin.hostname.includes(":")
        ? "ipv6"
        : "ipv4"
      : "dns",
    origin: origin.origin,
    host: origin.hostname,
    port: Number(origin.port || (origin.protocol === "https:" ? 443 : 80)),
    ...(input.resolvedIps === undefined
      ? {}
      : { resolvedIps: input.resolvedIps }),
    ...(input.relaySelf === undefined ? {} : { relaySelf: input.relaySelf }),
    rawPath,
    normalizedPath: new URL(pathUrl.pathname, origin).pathname,
    query: Array.from(pathUrl.searchParams.entries()),
    headers: input.headers,
    fetchOptions: input.fetchOptions,
    body: input.body ?? { availability: "unavailable" },
  };
}
