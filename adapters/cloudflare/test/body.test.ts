import { sha256Hex } from "@one-fetch/core";
import { describe, expect, it } from "vitest";

import { prepareRequestBody } from "../src/gateway/body";

const bytes = new TextEncoder().encode('{"blocked":true}');

describe("Cloudflare request body integrity", () => {
  it("does not trust a large declared size to bypass body inspection", async () => {
    await expect(
      prepareRequestBody(
        stream(bytes),
        2_000_000,
        undefined,
        undefined,
        "application/json",
        1_048_576,
        20_971_520,
      ),
    ).rejects.toMatchObject({
      problem: { code: "invalid_metadata", stage: "upload" },
    });
  });

  it("validates the actual size and digest before forwarding", async () => {
    const prepared = await prepareRequestBody(
      stream(bytes),
      bytes.byteLength,
      bytes.byteLength,
      await sha256Hex(bytes),
      "application/json",
      1_048_576,
      20_971_520,
    );

    expect(prepared.policy).toMatchObject({
      availability: "available",
      sizeBytes: bytes.byteLength,
    });
    expect(await new Response(prepared.body).text()).toBe('{"blocked":true}');
  });

  it("rejects a mismatched digest", async () => {
    await expect(
      prepareRequestBody(
        stream(bytes),
        bytes.byteLength,
        undefined,
        "0".repeat(64),
        "application/json",
        1_048_576,
        20_971_520,
      ),
    ).rejects.toMatchObject({
      problem: { code: "invalid_metadata", stage: "upload" },
    });
  });

  it("stops a bounded body read when the execution signal is aborted", async () => {
    const controller = new AbortController();
    const pending = prepareRequestBody(
      new ReadableStream<Uint8Array>({
        pull: () => new Promise<void>(() => undefined),
      }),
      1,
      undefined,
      undefined,
      "application/octet-stream",
      1_048_576,
      20_971_520,
      controller.signal,
    );
    controller.abort(new DOMException("Stopped", "AbortError"));
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });
});

function stream(value: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(value);
      controller.close();
    },
  });
}
