import { PolicyRuleV1Schema, PolicySetV1Schema } from "@one-fetch/protocol";

export interface PolicyRuleDraft {
  id: string;
  name: string;
  enabled: boolean;
  action: "allow" | "deny";
  match: Record<string, unknown>;
}

export interface PolicyDraft {
  schemaVersion: 1;
  mode: "allowlist" | "blocklist";
  revision: number;
  rules: PolicyRuleDraft[];
}

export function parseRuleDraft(value: unknown): PolicyRuleDraft {
  return JSON.parse(
    JSON.stringify(PolicyRuleV1Schema.parse(value)),
  ) as PolicyRuleDraft;
}

export function parsePolicyDraft(value: unknown): PolicyDraft {
  return JSON.parse(
    JSON.stringify(PolicySetV1Schema.parse(value)),
  ) as PolicyDraft;
}
