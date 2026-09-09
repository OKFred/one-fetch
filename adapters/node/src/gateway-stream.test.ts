import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";

import { declaredResponseExceedsLimit } from "./gateway-stream.js";

const responseWithLength = (value: string): IncomingMessage =>
  ({ headers: { "content-length": value } }) as unknown as IncomingMessage;

describe("declared response limits", () => {
  it("rejects a known body above the configured limit", () => {
    expect(
      declaredResponseExceedsLimit(responseWithLength("20971521"), 20_971_520),
    ).toBe(true);
  });

  it("allows the exact boundary and treats invalid lengths as unknown", () => {
    expect(
      declaredResponseExceedsLimit(responseWithLength("20971520"), 20_971_520),
    ).toBe(false);
    expect(
      declaredResponseExceedsLimit(responseWithLength("invalid"), 20_971_520),
    ).toBe(false);
  });
});
