import { classifyFetchOptions } from "@one-fetch/core";

import { SUPABASE_FETCH_OPTIONS } from "../_shared/capabilities.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

Deno.test("Supabase rejects Fetch options it does not implement", () => {
  for (
    const [name, value] of [
      ["cache", "no-store"],
      ["credentials", "include"],
      ["decompress", false],
      ["duplex", "half"],
      ["integrity", "sha256-deadbeef"],
      ["keepalive", true],
      ["mode", "cors"],
      ["priority", "high"],
      ["referrerPolicy", "no-referrer"],
    ] as const
  ) {
    const result = classifyFetchOptions(
      { redirect: "manual", timeoutMs: 60_000, [name]: value },
      SUPABASE_FETCH_OPTIONS,
    );
    assert(!result.allowed, `${name} was incorrectly accepted`);
  }
});

Deno.test(
  "Supabase referrer translation requires explicit confirmation",
  () => {
    const unconfirmed = classifyFetchOptions(
      {
        redirect: "manual",
        timeoutMs: 60_000,
        referrer: "https://source.example/path",
      },
      SUPABASE_FETCH_OPTIONS,
    );
    assert(unconfirmed.allowed, "referrer translation should be representable");
    assert(
      unconfirmed.requiresConfirmation,
      "referrer translation must require confirmation",
    );

    const confirmed = classifyFetchOptions(
      {
        redirect: "manual",
        timeoutMs: 60_000,
        referrer: "https://source.example/path",
        adapter: { supabaseAcceptMutations: true },
      },
      SUPABASE_FETCH_OPTIONS,
    );
    assert(confirmed.allowed, "confirmation flag should be accepted");
  },
);
