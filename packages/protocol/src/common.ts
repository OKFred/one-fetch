import { z } from "zod";

import { ONE_FETCH_LIMITS_V1 } from "./constants.js";

const HTTP_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u;
const BASE64_URL = /^[A-Za-z0-9_-]+$/u;

export const JsonPrimitiveSchema = z.union([
  z.string(),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);
export type JsonPrimitive = z.infer<typeof JsonPrimitiveSchema>;

export type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | { [key: string]: JsonValue };
export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    JsonPrimitiveSchema,
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ]),
);

export const HeaderEntryV1Schema = z
  .object({
    name: z
      .string()
      .min(1)
      .max(ONE_FETCH_LIMITS_V1.headerNameBytes)
      .regex(HTTP_TOKEN, "Header name must be an RFC 9110 token"),
    value: z
      .string()
      .max(ONE_FETCH_LIMITS_V1.headerValueBytes)
      .refine(
        (value) => !/[\r\n]/u.test(value),
        "Header values cannot contain CR or LF",
      ),
  })
  .strict();
export type HeaderEntryV1 = z.infer<typeof HeaderEntryV1Schema>;

export const RequestIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/u);
export const NonceSchema = z
  .string()
  .regex(/^[a-f0-9]{32}$/u, "Nonce must be 128-bit lowercase hex");
export const Base64UrlSchema = z.string().min(1).regex(BASE64_URL);

export const Sha256HexSchema = z.string().regex(/^[a-f0-9]{64}$/u);
export const IsoDateTimeSchema = z.iso.datetime({ offset: true });

export function isExactOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === "https:" || url.protocol === "http:") &&
      url.username === "" &&
      url.password === "" &&
      url.pathname === "/" &&
      url.search === "" &&
      url.hash === "" &&
      url.origin === value
    );
  } catch {
    return false;
  }
}

export const ExactHttpOriginSchema = z
  .string()
  .max(2_048)
  .refine(
    isExactOrigin,
    "Expected an exact HTTP(S) origin without path, query, hash, or userinfo",
  );
