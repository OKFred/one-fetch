import type { z } from "zod";

import { ONE_FETCH_LIMITS_V1 } from "./constants.js";
import {
  OneFetchRequestMetaV1Schema,
  OneFetchResponseMetaV1Schema,
  type OneFetchRequestMetaV1,
  type OneFetchResponseMetaV1,
} from "./metadata.js";

export class ProtocolCodecError extends Error {
  readonly code: "invalid_metadata" | "metadata_too_large";

  constructor(
    code: "invalid_metadata" | "metadata_too_large",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ProtocolCodecError";
    this.code = code;
  }
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(
      ...bytes.subarray(offset, offset + chunkSize),
    );
  }
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function base64UrlToBytes(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new ProtocolCodecError(
      "invalid_metadata",
      "Metadata is not Base64URL",
    );
  }
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  try {
    const binary = atob(
      value.replaceAll("-", "+").replaceAll("_", "/") + padding,
    );
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch (error) {
    throw new ProtocolCodecError(
      "invalid_metadata",
      "Metadata is not valid Base64URL",
      { cause: error },
    );
  }
}

function encodeWithSchema<T>(schema: z.ZodType<T>, value: T): string {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new ProtocolCodecError("invalid_metadata", parsed.error.message);
  }
  const bytes = new TextEncoder().encode(JSON.stringify(parsed.data));
  if (bytes.byteLength > ONE_FETCH_LIMITS_V1.metadataBytes) {
    throw new ProtocolCodecError(
      "metadata_too_large",
      `Metadata is ${bytes.byteLength} bytes; maximum is ${ONE_FETCH_LIMITS_V1.metadataBytes}`,
    );
  }
  return bytesToBase64Url(bytes);
}

function decodeWithSchema<T>(schema: z.ZodType<T>, value: string): T {
  const bytes = base64UrlToBytes(value);
  if (bytes.byteLength > ONE_FETCH_LIMITS_V1.metadataBytes) {
    throw new ProtocolCodecError(
      "metadata_too_large",
      `Metadata is ${bytes.byteLength} bytes; maximum is ${ONE_FETCH_LIMITS_V1.metadataBytes}`,
    );
  }
  let unknownValue: unknown;
  try {
    unknownValue = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
  } catch (error) {
    throw new ProtocolCodecError(
      "invalid_metadata",
      "Metadata is not valid UTF-8 JSON",
      { cause: error },
    );
  }
  const parsed = schema.safeParse(unknownValue);
  if (!parsed.success) {
    throw new ProtocolCodecError("invalid_metadata", parsed.error.message);
  }
  return parsed.data;
}

export function encodeRequestMetadata(value: OneFetchRequestMetaV1): string {
  return encodeWithSchema(OneFetchRequestMetaV1Schema, value);
}

export function decodeRequestMetadata(value: string): OneFetchRequestMetaV1 {
  return decodeWithSchema(OneFetchRequestMetaV1Schema, value);
}

export function encodeResponseMetadata(value: OneFetchResponseMetaV1): string {
  return encodeWithSchema(OneFetchResponseMetaV1Schema, value);
}

export function decodeResponseMetadata(value: string): OneFetchResponseMetaV1 {
  return decodeWithSchema(OneFetchResponseMetaV1Schema, value);
}
