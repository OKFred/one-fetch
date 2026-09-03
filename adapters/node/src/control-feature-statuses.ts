import {
  ControlFeatureStatusListV1Schema,
  type ControlFeatureStatusListV1,
} from "@one-fetch/protocol";

export const controlFeatureStatuses = (): ControlFeatureStatusListV1 =>
  ControlFeatureStatusListV1Schema.parse({
    schemaVersion: 1,
    features: [
      {
        schemaVersion: 1,
        feature: "alerts",
        state: "unsupported",
        reason: "Signed Webhook alerts are not available in the Node Preview",
      },
      {
        schemaVersion: 1,
        feature: "backups",
        state: "unsupported",
        reason: "Use the documented SQLite backup runbook during Preview",
      },
      {
        schemaVersion: 1,
        feature: "audit-export",
        state: "unsupported",
        reason: "Signed JSONL export is not available in the Node Preview",
      },
      { schemaVersion: 1, feature: "gateway-pause", state: "supported" },
      { schemaVersion: 1, feature: "sessions", state: "supported" },
      { schemaVersion: 1, feature: "totp", state: "supported" },
      { schemaVersion: 1, feature: "password-change", state: "supported" },
      {
        schemaVersion: 1,
        feature: "webhooks",
        state: "unsupported",
        reason: "Webhook delivery is not available in the Node Preview",
      },
    ],
  });
