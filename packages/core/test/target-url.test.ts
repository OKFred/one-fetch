import { describe, expect, it } from "vitest";
import {
  createHttpPolicyContext,
  evaluateSystemPolicy,
  targetUrlFromPath,
} from "../src/index.js";

const origin = "https://api.example:8443";
describe("origin-bound target paths", () => {
  it.each([
    "/v1/items?x=1&x=2",
    "//other.example/v1?x=1&x=2",
    "///v1///items?empty=&bare&&=value",
    "//user:password@other.example:9000/v1",
    "//[not-a-host]/items",
    "//v1/%2F%2f?x=%2f&x=+&x=%20",
  ])(
    "keeps origin, raw/normalized path and duplicate query aligned: %s",
    (path) => {
      const expected = new URL(`${origin}${path}`);
      const target = targetUrlFromPath(origin, path);
      const context = createHttpPolicyContext({
        targetOrigin: origin,
        pathAndQuery: path,
        method: "GET",
        headers: [],
        fetchOptions: { timeoutMs: 60_000, redirect: "follow" },
      });
      expect(target.href).toBe(expected.href);
      expect(target.origin).toBe(origin);
      expect(context.origin).toBe(origin);
      expect(context.host).toBe("api.example");
      expect(context.port).toBe(8443);
      expect(context.rawPath).toBe(path.split("?")[0]);
      expect(context.normalizedPath).toBe(expected.pathname);
      expect(context.query).toEqual([...expected.searchParams]);
      expect(
        evaluateSystemPolicy(
          {
            schemaVersion: 1,
            mode: "allowlist",
            revision: 1,
            rules: [
              {
                id: "exact",
                name: "Exact path",
                enabled: true,
                action: "allow",
                match: {
                  origins: [{ operator: "exact", value: origin }],
                  path: {
                    representation: "normalized",
                    value: { operator: "exact", value: expected.pathname },
                  },
                },
              },
            ],
          },
          context,
        ).decision,
      ).toBe("allow");
    },
  );

  it("does not accept an absolute URL in the HTTP path slot", () => {
    expect(() => targetUrlFromPath(origin, "https://other.example/x")).toThrow(
      "must start with /",
    );
  });
});
