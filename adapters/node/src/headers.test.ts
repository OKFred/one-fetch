import { describe, expect, it } from "vitest";

import { ONE_FETCH_LIMITS_V1 } from "@one-fetch/protocol";

import { reconcileContentType } from "./headers.js";

describe("request Content-Type reconciliation", () => {
  it("materializes metadata-only Content-Type into the forwarded headers", () => {
    expect(reconcileContentType([], "application/json")).toEqual([
      { name: "Content-Type", value: "application/json" },
    ]);
  });

  it("keeps one exactly matching target header authoritative", () => {
    const headers = [{ name: "content-type", value: "application/json" }];
    expect(reconcileContentType(headers, "application/json")).toBe(headers);
  });

  it.each([
    {
      declared: "text/plain",
      headers: [{ name: "Content-Type", value: "application/json" }],
    },
    {
      declared: undefined,
      headers: [
        { name: "Content-Type", value: "application/json" },
        { name: "content-type", value: "text/plain" },
      ],
    },
    {
      declared: " ",
      headers: [],
    },
    {
      declared: undefined,
      headers: [{ name: "Content-Type", value: "" }],
    },
    {
      declared: "application/json",
      headers: Array.from({ length: ONE_FETCH_LIMITS_V1.headers }, () => ({
        name: "X-Filler",
        value: "value",
      })),
    },
  ])(
    "rejects ambiguous or empty Content-Type input",
    ({ headers, declared }) => {
      expect(reconcileContentType(headers, declared)).toBeUndefined();
    },
  );
});
