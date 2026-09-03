import type { OneFetchRequestMetaV1 } from "../_shared/protocol-types.ts";
import {
  requestContentType,
  targetHeaderEntries,
} from "../_shared/upstream.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function metadata(contentType?: string): OneFetchRequestMetaV1 {
  return {
    protocolVersion: 1,
    requestId: "request-content-type",
    nonce: "0123456789abcdef0123456789abcdef",
    transport: "http",
    targetOrigin: "https://api.example",
    targetHeaders: [],
    fetchOptions: { redirect: "manual", timeoutMs: 60_000 },
    body: { ...(contentType ? { contentType } : {}) },
    hop: 0,
  };
}

Deno.test("Policy content type comes from the actual target header", () => {
  const value = requestContentType(
    [{ name: "Content-Type", value: "application/json" }],
    metadata("application/json"),
  );
  assert(value === "application/json", "target content type was lost");
});

Deno.test("Conflicting or metadata-only content types are rejected", () => {
  for (
    const entries of [
      [{ name: "Content-Type", value: "text/plain" }],
      [],
      [
        { name: "Content-Type", value: "application/json" },
        { name: "content-type", value: "application/json" },
      ],
    ]
  ) {
    let rejected = false;
    try {
      requestContentType(entries, metadata("application/json"));
    } catch {
      rejected = true;
    }
    assert(rejected, "ambiguous content type was accepted");
  }
});

Deno.test("Fetch referrer cannot silently override an explicit header", () => {
  const request = metadata();
  request.fetchOptions.referrer = "https://source.example/from-option";
  request.fetchOptions.adapter = { supabaseAcceptMutations: true };
  let rejected = false;
  try {
    targetHeaderEntries(
      [{ name: "Referer", value: "https://source.example/from-header" }],
      request,
    );
  } catch {
    rejected = true;
  }
  assert(rejected, "conflicting referrer sources were silently accepted");
});
