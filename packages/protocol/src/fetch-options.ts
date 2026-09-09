import { z } from "zod";

import { JsonValueSchema } from "./common.js";

export const FetchOptionNameSchema = z.enum([
  "redirect",
  "timeoutMs",
  "cache",
  "credentials",
  "integrity",
  "keepalive",
  "mode",
  "priority",
  "referrer",
  "referrerPolicy",
  "duplex",
  "decompress",
]);
export type FetchOptionName = z.infer<typeof FetchOptionNameSchema>;

export const FetchOptionsV1Schema = z
  .object({
    redirect: z.enum(["follow", "manual", "error"]),
    timeoutMs: z.number().int().min(1).max(86_400_000),
    cache: z
      .enum([
        "default",
        "no-store",
        "reload",
        "no-cache",
        "force-cache",
        "only-if-cached",
      ])
      .optional(),
    credentials: z.enum(["omit", "same-origin", "include"]).optional(),
    integrity: z.string().max(4_096).optional(),
    keepalive: z.boolean().optional(),
    mode: z.enum(["same-origin", "no-cors", "cors", "navigate"]).optional(),
    priority: z.enum(["high", "low", "auto"]).optional(),
    referrer: z.string().max(8_192).optional(),
    referrerPolicy: z
      .enum([
        "",
        "no-referrer",
        "no-referrer-when-downgrade",
        "origin",
        "origin-when-cross-origin",
        "same-origin",
        "strict-origin",
        "strict-origin-when-cross-origin",
        "unsafe-url",
      ])
      .optional(),
    duplex: z.literal("half").optional(),
    decompress: z.boolean().optional(),
    adapter: z.record(z.string().min(1).max(128), JsonValueSchema).optional(),
  })
  .strict();
export type FetchOptionsV1 = z.infer<typeof FetchOptionsV1Schema>;

export const FetchOptionFidelitySchema = z.enum([
  "exact",
  "translated",
  "unsupported",
  "vendor-mutated",
]);
export type FetchOptionFidelity = z.infer<typeof FetchOptionFidelitySchema>;

export const FetchOptionCapabilityV1Schema = z
  .object({
    option: z.string().min(1).max(128),
    fidelity: FetchOptionFidelitySchema,
    detail: z.string().min(1).max(1_024).optional(),
    acceptedValues: z.array(JsonValueSchema).max(64).optional(),
  })
  .strict();
export type FetchOptionCapabilityV1 = z.infer<
  typeof FetchOptionCapabilityV1Schema
>;

export const FetchOptionAssessmentV1Schema =
  FetchOptionCapabilityV1Schema.extend({
    value: JsonValueSchema,
  }).strict();
export type FetchOptionAssessmentV1 = z.infer<
  typeof FetchOptionAssessmentV1Schema
>;
