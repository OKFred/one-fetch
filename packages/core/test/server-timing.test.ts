import { describe, expect, it } from "vitest";

import { parseServerTiming } from "../src/server-timing.js";

describe("parseServerTiming", () => {
  it("keeps quoted commas inside a description", () => {
    expect(
      parseServerTiming('db;dur=1.5;desc="primary, replica", app;dur=2'),
    ).toEqual([
      { name: "db", durationMs: 1.5, description: "primary, replica" },
      { name: "app", durationMs: 2 },
    ]);
  });

  it("keeps quoted semicolons inside a description", () => {
    expect(parseServerTiming('app;desc="parse; render";dur=2.25')).toEqual([
      { name: "app", durationMs: 2.25, description: "parse; render" },
    ]);
  });

  it("unescapes quoted pairs without splitting escaped quotes", () => {
    expect(
      parseServerTiming('cache;desc="hit \\"edge\\"; shard \\\\one"'),
    ).toEqual([{ name: "cache", description: 'hit "edge"; shard \\one' }]);
  });

  it("parses multiple header field values in their original order", () => {
    expect(
      parseServerTiming([
        'db;dur=1;desc="primary, replica"',
        'app;dur=2;desc="parse; render"',
        "edge;dur=3",
      ]),
    ).toEqual([
      { name: "db", durationMs: 1, description: "primary, replica" },
      { name: "app", durationMs: 2, description: "parse; render" },
      { name: "edge", durationMs: 3 },
    ]);
  });
});
