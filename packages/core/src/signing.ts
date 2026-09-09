import {
  OneFetchResponseMetaV1Schema,
  OneFetchUnsignedResponseMetaV1Schema,
  decodeResponseMetadata,
  type OneFetchProblemV1,
  type OneFetchResponseMetaV1,
  type OneFetchUnsignedResponseMetaV1,
} from "@one-fetch/protocol";

import {
  base64UrlToBytes,
  constantTimeEqual,
  deriveHmacKey,
  hmacBytes,
  stableStringify,
} from "./crypto.js";

async function responseSignature(
  metadata: OneFetchUnsignedResponseMetaV1,
  token: string,
): Promise<Uint8Array> {
  const key = await deriveHmacKey(
    token,
    metadata.nonce,
    `one-fetch-response-v1:${metadata.requestId}`,
  );
  return hmacBytes(key, stableStringify(metadata));
}

export async function createSignedResponseMetadata(
  metadata: OneFetchUnsignedResponseMetaV1,
  token: string,
): Promise<OneFetchResponseMetaV1> {
  const parsed = OneFetchUnsignedResponseMetaV1Schema.parse(metadata);
  const signature = await responseSignature(parsed, token);
  const encoded = btoa(String.fromCharCode(...signature))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
  return OneFetchResponseMetaV1Schema.parse({ ...parsed, signature: encoded });
}

export interface VerifyResponseOptions {
  token: string;
  requestId: string;
  nonce: string;
}

export async function verifySignedResponseMetadata(
  metadata: OneFetchResponseMetaV1,
  options: VerifyResponseOptions,
): Promise<boolean> {
  const parsed = OneFetchResponseMetaV1Schema.safeParse(metadata);
  if (!parsed.success) return false;
  if (
    parsed.data.requestId !== options.requestId ||
    parsed.data.nonce !== options.nonce
  )
    return false;
  const { signature, ...unsignedCandidate } = parsed.data;
  const unsigned =
    OneFetchUnsignedResponseMetaV1Schema.parse(unsignedCandidate);
  let supplied: Uint8Array;
  try {
    supplied = base64UrlToBytes(signature);
  } catch {
    return false;
  }
  return constantTimeEqual(
    supplied,
    await responseSignature(unsigned, options.token),
  );
}

export type OneFetchResponseClassification =
  | {
      source: "target";
      metadata: OneFetchResponseMetaV1;
      target: NonNullable<OneFetchResponseMetaV1["target"]>;
    }
  | {
      source: "relay";
      metadata: OneFetchResponseMetaV1;
      error: OneFetchProblemV1;
    }
  | {
      source: "intermediary";
      reason:
        | "missing-metadata"
        | "invalid-metadata"
        | "identity-mismatch"
        | "signature-invalid";
    };

export async function classifyOneFetchResponse(
  encodedMetadata: string | null | undefined,
  options: VerifyResponseOptions,
): Promise<OneFetchResponseClassification> {
  if (
    encodedMetadata === null ||
    encodedMetadata === undefined ||
    encodedMetadata === ""
  ) {
    return { source: "intermediary", reason: "missing-metadata" };
  }
  let metadata: OneFetchResponseMetaV1;
  try {
    metadata = decodeResponseMetadata(encodedMetadata);
  } catch {
    return { source: "intermediary", reason: "invalid-metadata" };
  }
  if (
    metadata.requestId !== options.requestId ||
    metadata.nonce !== options.nonce
  ) {
    return { source: "intermediary", reason: "identity-mismatch" };
  }
  if (!(await verifySignedResponseMetadata(metadata, options))) {
    return { source: "intermediary", reason: "signature-invalid" };
  }
  if (metadata.outcome === "target" && metadata.target !== undefined) {
    return { source: "target", metadata, target: metadata.target };
  }
  if (metadata.outcome === "relay-error" && metadata.error !== undefined) {
    return { source: "relay", metadata, error: metadata.error };
  }
  return { source: "intermediary", reason: "invalid-metadata" };
}
