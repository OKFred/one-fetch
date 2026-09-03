import { describe, expect, it } from "vitest";
import {
  cloneRecommendedRules,
  RECOMMENDED_GLOBAL_BLOCKLIST,
} from "./recommended-policy";

describe("recommended global blocklist", () => {
  it("is an optional disabled template", () => {
    expect(RECOMMENDED_GLOBAL_BLOCKLIST.length).toBeGreaterThan(4);
    expect(RECOMMENDED_GLOBAL_BLOCKLIST.every((rule) => !rule.enabled)).toBe(
      true,
    );
    expect(
      cloneRecommendedRules(new Set(["recommended-cleartext"])).some(
        ({ id }) => id === "recommended-cleartext",
      ),
    ).toBe(false);
  });
});
