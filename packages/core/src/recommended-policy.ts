import type {
  PolicyRuleV1,
  PolicySetV1,
  StringMatcherV1,
} from "@one-fetch/protocol";

export const RECOMMENDED_PRIVATE_AND_RESERVED_CIDRS_V1 = Object.freeze([
  "0.0.0.0/8",
  "10.0.0.0/8",
  "100.64.0.0/10",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "172.16.0.0/12",
  "192.0.0.0/24",
  "192.0.2.0/24",
  "192.168.0.0/16",
  "198.18.0.0/15",
  "198.51.100.0/24",
  "203.0.113.0/24",
  "224.0.0.0/4",
  "240.0.0.0/4",
  "::/128",
  "::1/128",
  "::ffff:0:0/96",
  "64:ff9b::/96",
  "fc00::/7",
  "fe80::/10",
  "ff00::/8",
  "2001:db8::/32",
] as const);

const HOST_MATCHERS: readonly StringMatcherV1[] = [
  { operator: "exact", value: "localhost", caseSensitive: false },
  { operator: "suffix", value: ".localhost", caseSensitive: false },
  { operator: "suffix", value: ".local", caseSensitive: false },
  { operator: "suffix", value: ".internal", caseSensitive: false },
  { operator: "suffix", value: ".home", caseSensitive: false },
  { operator: "suffix", value: ".lan", caseSensitive: false },
  {
    operator: "exact",
    value: "metadata.google.internal",
    caseSensitive: false,
  },
  { operator: "exact", value: "metadata.azure.internal", caseSensitive: false },
  {
    operator: "exact",
    value: "metadata.oraclecloud.com",
    caseSensitive: false,
  },
];

export const RECOMMENDED_GLOBAL_BLOCKLIST_WARNINGS_V1 = Object.freeze([
  "This is an opt-in template. Creating it does not activate or enforce it.",
  "CIDR matching is reliable only when the adapter checks every resolved address on every redirect; DNS pinning support is adapter-specific.",
  "The relay-self rule requires the adapter to derive relaySelf from its configured public origins.",
  "The userinfo rule relies on the authenticated client signal; also deny target Authorization headers if that distinction matters to your policy.",
  "A blocklist cannot provide the same SSRF safety boundary as an explicit allowlist.",
] as const);

function rule(
  id: string,
  name: string,
  match: PolicyRuleV1["match"],
): PolicyRuleV1 {
  return { id, name, enabled: true, action: "deny", match };
}

export function createRecommendedGlobalBlocklistV1(): PolicySetV1 {
  return {
    schemaVersion: 1,
    mode: "blocklist",
    revision: 0,
    rules: [
      rule("recommended-non-https", "Reject non-HTTPS HTTP targets", {
        schemes: ["http", "ws"],
      }),
      rule(
        "recommended-userinfo",
        "Reject URLs that originally contained userinfo",
        { hasUserinfo: true },
      ),
      rule("recommended-ip-literal", "Reject IPv4 and IPv6 literal hostnames", {
        hostKinds: ["ipv4", "ipv6"],
      }),
      rule(
        "recommended-local-and-metadata-hosts",
        "Reject local and cloud metadata hostnames",
        {
          hosts: [...HOST_MATCHERS],
        },
      ),
      rule(
        "recommended-private-and-reserved-addresses",
        "Reject private, link-local, metadata, and reserved addresses",
        {
          resolvedIpCidrs: [...RECOMMENDED_PRIVATE_AND_RESERVED_CIDRS_V1],
        },
      ),
      rule(
        "recommended-relay-self",
        "Reject recursive requests to this one-fetch instance",
        { relaySelf: true },
      ),
    ],
  };
}

export const RECOMMENDED_GLOBAL_BLOCKLIST_V1 = Object.freeze(
  createRecommendedGlobalBlocklistV1(),
);
