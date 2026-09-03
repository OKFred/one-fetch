import { z } from "zod";

import { ONE_FETCH_LIMITS_V1, PROTOCOL_VERSION } from "./constants.js";
import {
  OneFetchRequestMetaV1Schema,
  OneFetchResponseMetaV1Schema,
  type OneFetchRequestMetaV1,
  type OneFetchResponseMetaV1,
} from "./metadata.js";

export const TunnelClientHelloV1Schema = z
  .object({
    protocolVersion: z.literal(PROTOCOL_VERSION),
    type: z.literal("client-hello"),
    executionToken: z
      .string()
      .min(16)
      .max(4_096)
      .refine(
        (value) =>
          !value.includes("\r") &&
          !value.includes("\n") &&
          !value.includes("\u0000"),
        "Execution token contains an invalid character",
      ),
    request: OneFetchRequestMetaV1Schema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.request.transport === "http") {
      context.addIssue({
        code: "custom",
        message: "A tunnel hello cannot request the HTTP transport",
        path: ["request", "transport"],
      });
    }
  });
export type TunnelClientHelloV1 = z.infer<typeof TunnelClientHelloV1Schema>;

export const TunnelServerHelloV1Schema = z
  .object({
    protocolVersion: z.literal(PROTOCOL_VERSION),
    type: z.literal("server-hello"),
    response: OneFetchResponseMetaV1Schema,
  })
  .strict();
export type TunnelServerHelloV1 = z.infer<typeof TunnelServerHelloV1Schema>;

export class TunnelHelloCodecError extends Error {
  readonly code: "invalid_metadata" | "metadata_too_large";

  constructor(
    code: "invalid_metadata" | "metadata_too_large",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "TunnelHelloCodecError";
    this.code = code;
  }
}

function encode<T>(schema: z.ZodType<T>, value: T): string {
  const parsed = schema.safeParse(value);
  if (!parsed.success)
    throw new TunnelHelloCodecError("invalid_metadata", parsed.error.message);
  const text = JSON.stringify(parsed.data);
  const size = new TextEncoder().encode(text).byteLength;
  if (size > ONE_FETCH_LIMITS_V1.tunnelHelloBytes) {
    throw new TunnelHelloCodecError(
      "metadata_too_large",
      `Tunnel hello is ${size} bytes; maximum is ${ONE_FETCH_LIMITS_V1.tunnelHelloBytes}`,
    );
  }
  return text;
}

function decode<T>(schema: z.ZodType<T>, text: string): T {
  const size = new TextEncoder().encode(text).byteLength;
  if (size > ONE_FETCH_LIMITS_V1.tunnelHelloBytes) {
    throw new TunnelHelloCodecError(
      "metadata_too_large",
      `Tunnel hello is ${size} bytes; maximum is ${ONE_FETCH_LIMITS_V1.tunnelHelloBytes}`,
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new TunnelHelloCodecError(
      "invalid_metadata",
      "Tunnel hello is not valid JSON",
      {
        cause: error,
      },
    );
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success)
    throw new TunnelHelloCodecError("invalid_metadata", parsed.error.message);
  return parsed.data;
}

export function encodeTunnelClientHello(value: TunnelClientHelloV1): string {
  return encode(TunnelClientHelloV1Schema, value);
}

export function decodeTunnelClientHello(value: string): TunnelClientHelloV1 {
  return decode(TunnelClientHelloV1Schema, value);
}

export function encodeTunnelServerHello(value: TunnelServerHelloV1): string {
  return encode(TunnelServerHelloV1Schema, value);
}

export function decodeTunnelServerHello(value: string): TunnelServerHelloV1 {
  return decode(TunnelServerHelloV1Schema, value);
}

export function createTunnelClientHello(
  request: OneFetchRequestMetaV1,
  executionToken: string,
): TunnelClientHelloV1 {
  return TunnelClientHelloV1Schema.parse({
    protocolVersion: PROTOCOL_VERSION,
    type: "client-hello",
    executionToken,
    request,
  });
}

export function createTunnelServerHello(
  response: OneFetchResponseMetaV1,
): TunnelServerHelloV1 {
  return TunnelServerHelloV1Schema.parse({
    protocolVersion: PROTOCOL_VERSION,
    type: "server-hello",
    response,
  });
}
