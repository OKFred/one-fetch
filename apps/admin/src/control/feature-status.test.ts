import { describe, expect, it } from "vitest";

import { mapFeatureStatuses } from "./feature-status";

describe("feature status mapping", () => {
  it("enables only supported features and retains adapter explanations", () => {
    expect(
      mapFeatureStatuses([
        { schemaVersion: 1, feature: "sessions", state: "supported" },
        {
          schemaVersion: 1,
          feature: "backups",
          state: "unsupported",
          reason: "Use the operator runbook",
        },
      ]),
    ).toEqual({
      sessions: { available: true },
      backups: { available: false, detail: "Use the operator runbook" },
    });
  });
});
