import type { PolicySetV1 } from "@one-fetch/protocol";

import { randomId, stableJson } from "./crypto.js";
import type { DatabaseClient } from "./database.js";

export interface StoredConfiguration {
  controlGatewayPairId: string;
  policy: PolicySetV1;
  updatedAt: string;
  version: string;
}

const defaultPolicy = (): PolicySetV1 => ({
  mode: "allowlist",
  revision: 0,
  rules: [],
  schemaVersion: 1,
});

export class ConfigurationStore {
  constructor(private readonly database: DatabaseClient) {}

  async initialize(): Promise<void> {
    const existing = await this.database.get(
      "SELECT value_json FROM instance_config WHERE key = ?",
      ["configuration"],
    );
    if (existing) return;
    const now = new Date().toISOString();
    const configuration: StoredConfiguration = {
      controlGatewayPairId: randomId("pair"),
      policy: defaultPolicy(),
      updatedAt: now,
      version: `${now}:0`,
    };
    await this.database.run(
      "INSERT OR IGNORE INTO instance_config(key, value_json, updated_at) VALUES (?, ?, ?)",
      ["configuration", stableJson(configuration), now],
    );
  }

  async get(): Promise<StoredConfiguration> {
    const row = await this.database.get<{ value_json: string }>(
      "SELECT value_json FROM instance_config WHERE key = ?",
      ["configuration"],
    );
    if (!row) throw new Error("Instance configuration is missing");
    return JSON.parse(row.value_json) as StoredConfiguration;
  }

  prepareUpdate(
    current: StoredConfiguration,
    policy: PolicySetV1,
  ): {
    configuration: StoredConfiguration;
    operation: import("./database-protocol.js").SqlOperation;
  } {
    const updatedAt = new Date().toISOString();
    const configuration: StoredConfiguration = {
      ...current,
      policy: { ...policy, revision: current.policy.revision + 1 },
      updatedAt,
      version: `${updatedAt}:${current.policy.revision + 1}`,
    };
    return {
      configuration,
      operation: {
        kind: "run",
        sql: "UPDATE instance_config SET value_json = ?, updated_at = ? WHERE key = ?",
        parameters: [stableJson(configuration), updatedAt, "configuration"],
      },
    };
  }
}
