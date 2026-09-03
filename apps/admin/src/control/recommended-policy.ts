import type { PolicyRuleDraft } from "./policy-ui";

const exact = (value: string) => ({ operator: "exact" as const, value });

/**
 * Optional starting point only. Rules are inserted disabled and require an
 * explicit publish action. Deployers remain responsible for their policy.
 */
export const RECOMMENDED_GLOBAL_BLOCKLIST: readonly PolicyRuleDraft[] = [
  {
    id: "recommended-cleartext",
    name: "Reject cleartext HTTP and WebSocket",
    enabled: false,
    action: "deny",
    match: { schemes: ["http", "ws"] },
  },
  {
    id: "recommended-userinfo",
    name: "Reject URL userinfo",
    enabled: false,
    action: "deny",
    match: { hasUserinfo: true },
  },
  {
    id: "recommended-ip-literal",
    name: "Reject direct IP-literal targets",
    enabled: false,
    action: "deny",
    match: { hostKinds: ["ipv4", "ipv6"] },
  },
  {
    id: "recommended-localhost",
    name: "Reject localhost names",
    enabled: false,
    action: "deny",
    match: {
      hosts: [
        exact("localhost"),
        { operator: "suffix", value: ".localhost", caseSensitive: false },
      ],
    },
  },
  {
    id: "recommended-private-network",
    name: "Reject loopback, private, link-local and reserved networks",
    enabled: false,
    action: "deny",
    match: {
      resolvedIpCidrs: [
        "0.0.0.0/8",
        "10.0.0.0/8",
        "100.64.0.0/10",
        "127.0.0.0/8",
        "169.254.0.0/16",
        "172.16.0.0/12",
        "192.168.0.0/16",
        "198.18.0.0/15",
        "224.0.0.0/4",
        "::/128",
        "::1/128",
        "fc00::/7",
        "fe80::/10",
      ],
    },
  },
  {
    id: "recommended-cloud-metadata",
    name: "Reject common cloud metadata hostnames",
    enabled: false,
    action: "deny",
    match: {
      hosts: [
        exact("metadata.google.internal"),
        exact("metadata.google"),
        exact("instance-data.ec2.internal"),
        exact("metadata.azure.internal"),
      ],
    },
  },
  {
    id: "recommended-relay-loop",
    name: "Reject recursive one-fetch relay targets",
    enabled: false,
    action: "deny",
    match: { relaySelf: true },
  },
];

export function cloneRecommendedRules(
  existingIds: ReadonlySet<string>,
): PolicyRuleDraft[] {
  const suffix = Date.now().toString(36);
  return RECOMMENDED_GLOBAL_BLOCKLIST.filter(
    (rule) => !existingIds.has(rule.id),
  ).map((rule) => ({
    ...structuredClone(rule),
    id: existingIds.has(rule.id) ? `${rule.id}-${suffix}` : rule.id,
    enabled: false,
  }));
}
