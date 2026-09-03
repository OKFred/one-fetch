import { describe, expect, it } from "vitest";

import {
  AlertsResponseV1Schema,
  AuditPageV1Schema,
  CONTROL_ROUTES_V1,
  ChangePasswordRequestV1Schema,
  ControlErrorV1Schema,
  ControlFeatureStatusListV1Schema,
  ExecutionTokenListV1Schema,
  RuntimeConfigurationV1Schema,
} from "../src/index.js";

const configuration = {
  schemaVersion: 1 as const,
  instanceId: "instance-1",
  controlGatewayPairId: "pair-1",
  revision: 4,
  version: "20260904T000000.000Z-4-deadbeef",
  updatedAt: "2026-09-04T00:00:00.000Z",
  gatewayPaused: false,
  policy: {
    schemaVersion: 1 as const,
    mode: "allowlist" as const,
    revision: 3,
    rules: [],
  },
};

describe("Control API schemas", () => {
  it("accepts a strict, versioned runtime configuration", () => {
    expect(RuntimeConfigurationV1Schema.parse(configuration)).toEqual(
      configuration,
    );
    expect(
      RuntimeConfigurationV1Schema.safeParse({
        ...configuration,
        providerConfig: {},
      }).success,
    ).toBe(false);
  });

  it("uses an envelope for execution-token lists", () => {
    expect(
      ExecutionTokenListV1Schema.safeParse({ schemaVersion: 1, tokens: [] })
        .success,
    ).toBe(true);
    expect(ExecutionTokenListV1Schema.safeParse([]).success).toBe(false);
  });

  it("rejects unsigned or structurally incomplete audit entries", () => {
    expect(
      AuditPageV1Schema.safeParse({
        schemaVersion: 1,
        events: [{ schemaVersion: 1, eventId: "event-1" }],
      }).success,
    ).toBe(false);
  });

  it("represents unsupported management features without an ad-hoc error", () => {
    const value = {
      schemaVersion: 1 as const,
      feature: "alerts" as const,
      state: "unsupported" as const,
      reason: "This adapter does not implement alert delivery",
    };
    expect(AlertsResponseV1Schema.parse(value)).toEqual(value);
  });

  it("rejects duplicate feature status entries", () => {
    const feature = {
      schemaVersion: 1 as const,
      feature: "backups" as const,
      state: "unsupported" as const,
      reason: "Not available in Preview",
    };
    expect(
      ControlFeatureStatusListV1Schema.safeParse({
        schemaVersion: 1,
        features: [feature, feature],
      }).success,
    ).toBe(false);
  });

  it("defines strict session-security payloads", () => {
    expect(
      ChangePasswordRequestV1Schema.safeParse({
        schemaVersion: 1,
        currentPassword: "correct horse battery staple",
        newPassword: "correct horse battery staple",
      }).success,
    ).toBe(false);
    expect(CONTROL_ROUTES_V1.session("session-1")).toBe(
      "/api/v1/auth/sessions/session-1",
    );
    expect(CONTROL_ROUTES_V1.totpPrepare).toBe("/api/v1/auth/totp/prepare");
  });

  it("requires nested Control errors from arbitrary top-level payloads", () => {
    expect(
      ControlErrorV1Schema.safeParse({
        error: {
          code: "feature_unsupported",
          message: "Backups are unavailable",
          retryable: false,
          correlationId: "request-1",
        },
      }).success,
    ).toBe(true);
    expect(
      ControlErrorV1Schema.safeParse({
        code: "feature_unsupported",
        message: "Backups are unavailable",
      }).success,
    ).toBe(false);
  });
});

describe("Control API route contract", () => {
  it("keeps management routes under the Control origin", () => {
    expect(CONTROL_ROUTES_V1.auditEvents).toBe("/api/v1/audit");
    expect(CONTROL_ROUTES_V1.executionToken("token-1")).toBe(
      "/api/v1/tokens/execution/token-1",
    );
  });

  it("rejects unsafe dynamic path identifiers", () => {
    expect(() => CONTROL_ROUTES_V1.executionReport("../secrets")).toThrow(
      TypeError,
    );
  });
});
