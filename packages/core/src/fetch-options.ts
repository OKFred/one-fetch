import {
  FetchOptionsV1Schema,
  type FetchOptionAssessmentV1,
  type FetchOptionCapabilityV1,
  type FetchOptionsV1,
  type JsonValue,
} from "@one-fetch/protocol";

import { stableStringify } from "./crypto.js";

export interface FetchOptionsClassification {
  allowed: boolean;
  requiresConfirmation: boolean;
  assessments: FetchOptionAssessmentV1[];
}

function optionEntries(options: FetchOptionsV1): Array<[string, JsonValue]> {
  const result: Array<[string, JsonValue]> = [];
  for (const [name, value] of Object.entries(options)) {
    if (value === undefined || name === "adapter") continue;
    result.push([name, value]);
  }
  for (const [name, value] of Object.entries(options.adapter ?? {})) {
    result.push([`adapter.${name}`, value]);
  }
  return result;
}

export function classifyFetchOptions(
  options: FetchOptionsV1,
  capabilities: readonly FetchOptionCapabilityV1[],
): FetchOptionsClassification {
  const parsed = FetchOptionsV1Schema.parse(options);
  const byOption = new Map(
    capabilities.map((capability) => [capability.option, capability]),
  );
  const assessments = optionEntries(parsed).map(
    ([option, value]): FetchOptionAssessmentV1 => {
      const capability = byOption.get(option);
      if (capability === undefined) {
        return {
          option,
          value,
          fidelity: "unsupported",
          detail: "The adapter did not declare support for this option",
        };
      }
      if (
        capability.acceptedValues !== undefined &&
        !capability.acceptedValues.some(
          (candidate) => stableStringify(candidate) === stableStringify(value),
        )
      ) {
        return {
          option,
          value,
          fidelity: "unsupported",
          detail: "The adapter does not accept this value",
          acceptedValues: capability.acceptedValues,
        };
      }
      return { ...capability, value };
    },
  );
  return {
    assessments,
    allowed: assessments.every(({ fidelity }) => fidelity !== "unsupported"),
    requiresConfirmation: assessments.some(
      ({ fidelity }) =>
        fidelity === "translated" || fidelity === "vendor-mutated",
    ),
  };
}
