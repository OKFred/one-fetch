import { describe, expect, it } from "vitest";

import {
  encodeResponseMetadata,
  type OneFetchUnsignedResponseMetaV1,
} from "@one-fetch/protocol";

import {
  classifyOneFetchResponse,
  createSignedResponseMetadata,
  verifySignedResponseMetadata,
} from "../src/index.js";

const unsigned: OneFetchUnsignedResponseMetaV1 = {
  protocolVersion: 1,
  requestId: "r-1",
  nonce: "0123456789abcdef0123456789abcdef",
  outcome: "target",
  target: {
    kind: "http",
    status: 503,
    statusText: "Target unavailable",
    headers: [],
    setCookie: [],
    bodyComplete: true,
  },
  timing: { phases: [], serverTiming: [] },
  configVersionUsed: "20260904T000000.000Z-deadbeef",
  mutations: [],
  audit: { state: "recorded", eventId: "event-1" },
};

describe("signed response source distinction", () => {
  it("classifies a signed target 5xx as a target response", async () => {
    const metadata = await createSignedResponseMetadata(
      unsigned,
      "secret-token",
    );
    const result = await classifyOneFetchResponse(
      encodeResponseMetadata(metadata),
      {
        token: "secret-token",
        requestId: unsigned.requestId,
        nonce: unsigned.nonce,
      },
    );
    expect(result.source).toBe("target");
  });

  it("rejects a valid envelope signed for another token", async () => {
    const metadata = await createSignedResponseMetadata(
      unsigned,
      "secret-token",
    );
    expect(
      await verifySignedResponseMetadata(metadata, {
        token: "wrong-token",
        requestId: unsigned.requestId,
        nonce: unsigned.nonce,
      }),
    ).toBe(false);
  });

  it("treats missing metadata as an intermediary response regardless of status", async () => {
    expect(
      await classifyOneFetchResponse(null, {
        token: "secret-token",
        requestId: unsigned.requestId,
        nonce: unsigned.nonce,
      }),
    ).toEqual({ source: "intermediary", reason: "missing-metadata" });
  });

  it("classifies a signed protocol failure independently of its HTTP status", async () => {
    const metadata = await createSignedResponseMetadata(
      {
        protocolVersion: 1,
        requestId: unsigned.requestId,
        nonce: unsigned.nonce,
        outcome: "relay-error",
        error: {
          code: "quota_exceeded",
          origin: "one-fetch",
          stage: "quota",
          message: "Quota reached",
          retryable: true,
        },
        timing: unsigned.timing,
        configVersionUsed: unsigned.configVersionUsed,
        mutations: unsigned.mutations,
        audit: unsigned.audit,
      },
      "secret-token",
    );
    const result = await classifyOneFetchResponse(
      encodeResponseMetadata(metadata),
      {
        token: "secret-token",
        requestId: unsigned.requestId,
        nonce: unsigned.nonce,
      },
    );
    expect(result).toMatchObject({
      source: "relay",
      error: { code: "quota_exceeded" },
    });
  });
});
