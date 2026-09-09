import type { ControlFeatureStatusV1 } from "@one-fetch/protocol";

import type { FeatureState } from "./types";

export function mapFeatureStatuses(
  statuses: readonly ControlFeatureStatusV1[],
): Record<string, FeatureState> {
  return Object.fromEntries(
    statuses.map((feature) => [
      feature.feature,
      {
        available: feature.state === "supported",
        ...("reason" in feature
          ? { detail: feature.reason }
          : feature.detail
            ? { detail: feature.detail }
            : {}),
      },
    ]),
  );
}
