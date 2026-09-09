import type { PolicySetV1, RuntimeConfigurationV1 } from "@one-fetch/protocol";

import { randomId, stableJson } from "./crypto.js";
import type { DatabaseClient } from "./database.js";
import type { SqlOperation } from "./database-protocol.js";

export type StoredConfiguration = RuntimeConfigurationV1;

const defaultPolicy = (): PolicySetV1 => ({
  mode: "allowlist",
  revision: 0,
  rules: [],
  schemaVersion: 1,
});

export class ConfigurationStore {
  constructor(
    private readonly database: DatabaseClient,
    private readonly instanceId: string,
  ) {}

  async initialize(): Promise<void> {
    const existing = await this.database.get(
      "SELECT value_json FROM instance_config WHERE key = ?",
      ["configuration"],
    );
    if (existing) return;
    const now = new Date().toISOString();
    const configuration: StoredConfiguration = {
      controlGatewayPairId: randomId("pair"),
      gatewayPaused: false,
      instanceId: this.instanceId,
      policy: defaultPolicy(),
      revision: 0,
      schemaVersion: 1,
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
    const value = JSON.parse(row.value_json) as Partial<StoredConfiguration>;
    const policy = value.policy ?? defaultPolicy();
    return {
      controlGatewayPairId: value.controlGatewayPairId ?? randomId("pair"),
      gatewayPaused: value.gatewayPaused ?? false,
      instanceId: value.instanceId ?? this.instanceId,
      policy,
      revision: value.revision ?? policy.revision,
      schemaVersion: 1,
      updatedAt: value.updatedAt ?? new Date(0).toISOString(),
      version: value.version ?? `${new Date(0).toISOString()}:0`,
    };
  }

  prepareUpdate(
    current: StoredConfiguration,
    policy: PolicySetV1,
  ): {
    configuration: StoredConfiguration;
    operation: SqlOperation;
  } {
    const updatedAt = new Date().toISOString();
    const configuration: StoredConfiguration = {
      ...current,
      policy: { ...policy, revision: current.policy.revision + 1 },
      revision: current.revision + 1,
      updatedAt,
      version: `${updatedAt}:${current.revision + 1}`,
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

  prepareGatewayPaused(
    current: StoredConfiguration,
    paused: boolean,
  ): {
    configuration: StoredConfiguration;
    operation: SqlOperation;
  } {
    const updatedAt = new Date().toISOString();
    const configuration: StoredConfiguration = {
      ...current,
      gatewayPaused: paused,
      revision: current.revision + 1,
      updatedAt,
      version: `${updatedAt}:${current.revision + 1}`,
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
