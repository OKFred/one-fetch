import { lookup } from "node:dns/promises";
import { performance } from "node:perf_hooks";

import {
  createHttpPolicyContext,
  evaluateSystemPolicy,
  evaluateUserDenyRules,
  isIpLiteral,
  type PolicyRequestContext,
} from "@one-fetch/core";
import type { OneFetchRequestMetaV1 } from "@one-fetch/protocol";

import type { ExecutionCredential } from "./auth.js";
import type { NodeAdapterConfig } from "./config.js";
import type { StoredConfiguration } from "./configuration.js";
import { failure } from "./gateway-error.js";

export interface TunnelResolution {
  address: string;
  dnsDurationMs: number;
  family: number;
}

export interface ApprovedTunnelTarget {
  port: number;
  resolution: TunnelResolution;
  url?: URL;
}

const tokenAllows = (
  credential: ExecutionCredential,
  metadata: OneFetchRequestMetaV1,
): boolean => {
  if (!credential.scopes.includes(metadata.transport)) return false;
  if (credential.allowedOrigins.includes("*")) return true;
  if (metadata.targetOrigin)
    return credential.allowedOrigins.includes(metadata.targetOrigin);
  const authority = metadata.targetAuthority;
  return (
    authority !== undefined &&
    credential.allowedOrigins.includes(
      `${metadata.transport}://${authority.host}:${authority.port}`,
    )
  );
};

const tunnelContext = (
  metadata: OneFetchRequestMetaV1,
  pathAndQuery: string,
  resolvedIp: string,
  gatewayOrigin: string,
): PolicyRequestContext => {
  if (metadata.transport === "websocket") {
    const context = createHttpPolicyContext({
      body: { availability: "unavailable" },
      fetchOptions: metadata.fetchOptions,
      ...(metadata.targetUrlTraits
        ? { hasUserinfo: metadata.targetUrlTraits.hasUserinfo }
        : {}),
      headers: metadata.targetHeaders,
      method: "GET",
      pathAndQuery,
      relaySelf:
        new URL(metadata.targetOrigin!).origin ===
        new URL(gatewayOrigin).origin,
      resolvedIps: [resolvedIp],
      targetOrigin: metadata.targetOrigin!,
      transport: "websocket",
    });
    context.websocketSubprotocols = metadata.targetHeaders
      .filter(({ name }) => name.toLowerCase() === "sec-websocket-protocol")
      .flatMap(({ value }) => value.split(","))
      .map((value) => value.trim())
      .filter(Boolean);
    return context;
  }

  const authority = metadata.targetAuthority!;
  return {
    alpn: authority.alpn ?? [],
    body: { availability: "unavailable" },
    fetchOptions: metadata.fetchOptions,
    hasUserinfo: false,
    headers: [],
    host: authority.host,
    hostKind: isIpLiteral(authority.host)
      ? authority.host.includes(":")
        ? "ipv6"
        : "ipv4"
      : "dns",
    port: authority.port,
    query: [],
    relaySelf: false,
    resolvedIps: [resolvedIp],
    ...(authority.sni ? { sni: authority.sni } : {}),
    transport: metadata.transport,
  };
};

const policyAllows = (
  metadata: OneFetchRequestMetaV1,
  configuration: StoredConfiguration,
  pathAndQuery: string,
  resolvedIp: string,
  gatewayOrigin: string,
): boolean => {
  const context = tunnelContext(
    metadata,
    pathAndQuery,
    resolvedIp,
    gatewayOrigin,
  );
  return (
    evaluateSystemPolicy(configuration.policy, context).decision === "allow" &&
    evaluateUserDenyRules(metadata.userDenyRules, context).decision === "allow"
  );
};

export const approveTunnelTarget = async (
  metadata: OneFetchRequestMetaV1,
  credential: ExecutionCredential,
  configuration: StoredConfiguration,
  config: NodeAdapterConfig,
  pathAndQuery: string,
): Promise<ApprovedTunnelTarget> => {
  if (!tokenAllows(credential, metadata)) {
    throw failure(
      "target_not_allowed",
      "authorization",
      "Execution token does not allow this tunnel target",
      403,
    );
  }
  if (metadata.hop > 0) {
    throw failure(
      "target_not_allowed",
      "policy",
      "Relayed one-fetch recursion is not allowed",
      403,
    );
  }

  const url =
    metadata.transport === "websocket"
      ? new URL(pathAndQuery, metadata.targetOrigin)
      : undefined;
  if (url && url.origin === new URL(config.publicGatewayUrl).origin) {
    throw failure(
      "target_not_allowed",
      "policy",
      "Recursive one-fetch target is not allowed",
      403,
    );
  }
  const host = url?.hostname ?? metadata.targetAuthority!.host;
  const port = url
    ? Number(url.port || (url.protocol === "https:" ? 443 : 80))
    : metadata.targetAuthority!.port;
  const dnsStarted = performance.now();
  const addresses = await lookup(host, { all: true, verbatim: true });
  const dnsDurationMs = performance.now() - dnsStarted;
  for (const candidate of addresses) {
    if (
      policyAllows(
        metadata,
        configuration,
        pathAndQuery,
        candidate.address,
        config.publicGatewayUrl,
      )
    ) {
      return {
        port,
        resolution: {
          address: candidate.address,
          dnsDurationMs,
          family: candidate.family,
        },
        ...(url ? { url } : {}),
      };
    }
  }
  throw failure(
    "target_not_allowed",
    "policy",
    "No resolved target address was approved by policy",
    403,
  );
};
