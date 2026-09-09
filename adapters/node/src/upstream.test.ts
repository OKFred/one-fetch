import type { LookupAddress, LookupOptions } from "node:dns";
import { Socket } from "node:net";
import { describe, expect, it } from "vitest";

import {
  observeSocketTiming,
  pinnedLookup,
  type ResolvedTarget,
} from "./upstream.js";

function invokeLookup(
  target: ResolvedTarget,
  options: LookupOptions,
): Promise<string | LookupAddress[]> {
  return new Promise((resolve, reject) => {
    pinnedLookup(target)("ignored.example", options, (error, address) => {
      if (error) reject(error);
      else resolve(address);
    });
  });
}

describe("pinned DNS lookup", () => {
  const target = { address: "203.0.113.8", dnsDurationMs: 1, family: 4 };

  it("returns a single address to legacy callers", async () => {
    await expect(invokeLookup(target, {})).resolves.toBe("203.0.113.8");
  });

  it("returns an address array when Node enables auto-family selection", async () => {
    await expect(invokeLookup(target, { all: true })).resolves.toEqual([
      { address: "203.0.113.8", family: 4 },
    ]);
  });
});

describe("upstream socket timing", () => {
  it("records a reused connection without adding dead listeners", () => {
    const socket = new Socket();
    const timing: Parameters<typeof observeSocketTiming>[2] = [];
    expect(socket.connecting).toBe(false);
    observeSocketTiming(socket, true, timing);
    expect(timing).toMatchObject([
      { name: "connect", state: "reused" },
      { name: "tls", state: "reused" },
    ]);
    expect(socket.listenerCount("connect")).toBe(0);
    expect(socket.listenerCount("secureConnect")).toBe(0);
    socket.destroy();
  });
});
