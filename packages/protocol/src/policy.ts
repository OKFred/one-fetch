import { z } from "zod";

import {
  HeaderEntryV1Schema,
  JsonPrimitiveSchema,
  JsonValueSchema,
} from "./common.js";
import { FetchOptionNameSchema } from "./fetch-options.js";

export const StringMatcherV1Schema = z
  .object({
    operator: z.enum(["exact", "prefix", "suffix", "contains", "glob"]),
    value: z.string().max(8_192),
    caseSensitive: z.boolean().optional(),
  })
  .strict();
export type StringMatcherV1 = z.infer<typeof StringMatcherV1Schema>;

export const NamedValueMatcherV1Schema = z
  .object({
    name: StringMatcherV1Schema,
    value: StringMatcherV1Schema.optional(),
    presence: z.enum(["present", "absent"]),
  })
  .strict();
export type NamedValueMatcherV1 = z.infer<typeof NamedValueMatcherV1Schema>;

const OnUnavailableSchema = z.enum(["deny", "no-match"]);

const JsonBodyMatcherV1Schema = z
  .object({
    kind: z.literal("json"),
    pointer: z.string().startsWith("/").max(4_096).or(z.literal("")),
    operator: z.enum(["exists", "equals", "string-match"]),
    value: JsonPrimitiveSchema.optional(),
    string: StringMatcherV1Schema.optional(),
    onUnavailable: OnUnavailableSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.operator === "equals" && value.value === undefined) {
      context.addIssue({
        code: "custom",
        message: "equals requires value",
        path: ["value"],
      });
    }
    if (value.operator === "string-match" && value.string === undefined) {
      context.addIssue({
        code: "custom",
        message: "string-match requires string",
        path: ["string"],
      });
    }
  });

const FormBodyMatcherV1Schema = z
  .object({
    kind: z.literal("form"),
    field: NamedValueMatcherV1Schema,
    onUnavailable: OnUnavailableSchema,
  })
  .strict();

const MultipartBodyMatcherV1Schema = z
  .object({
    kind: z.literal("multipart"),
    partName: StringMatcherV1Schema,
    filename: StringMatcherV1Schema.optional(),
    contentType: StringMatcherV1Schema.optional(),
    text: StringMatcherV1Schema.optional(),
    onUnavailable: OnUnavailableSchema,
  })
  .strict();

const TextBodyMatcherV1Schema = z
  .object({
    kind: z.literal("text"),
    value: StringMatcherV1Schema,
    onUnavailable: OnUnavailableSchema,
  })
  .strict();

const BinaryBodyMatcherV1Schema = z
  .object({
    kind: z.literal("binary"),
    minBytes: z.number().int().nonnegative().optional(),
    maxBytes: z.number().int().nonnegative().optional(),
    contentType: StringMatcherV1Schema.optional(),
    onUnavailable: OnUnavailableSchema,
  })
  .strict()
  .refine(
    (value) =>
      value.minBytes === undefined ||
      value.maxBytes === undefined ||
      value.minBytes <= value.maxBytes,
    { message: "minBytes cannot exceed maxBytes" },
  );

export const BodyMatcherV1Schema = z.union([
  JsonBodyMatcherV1Schema,
  FormBodyMatcherV1Schema,
  MultipartBodyMatcherV1Schema,
  TextBodyMatcherV1Schema,
  BinaryBodyMatcherV1Schema,
]);
export type BodyMatcherV1 = z.infer<typeof BodyMatcherV1Schema>;

export const FetchOptionMatcherV1Schema = z
  .object({
    option: FetchOptionNameSchema.or(
      z.string().startsWith("adapter.").max(256),
    ),
    value: JsonValueSchema.optional(),
    presence: z.enum(["present", "absent"]),
  })
  .strict();
export type FetchOptionMatcherV1 = z.infer<typeof FetchOptionMatcherV1Schema>;

export const PolicyMatchV1Schema = z
  .object({
    transports: z
      .array(z.enum(["http", "websocket", "tcp", "tls"]))
      .min(1)
      .max(4)
      .optional(),
    methods: z.array(z.string().min(1).max(32)).min(1).max(32).optional(),
    schemes: z
      .array(z.enum(["http", "https", "ws", "wss"]))
      .min(1)
      .max(4)
      .optional(),
    hasUserinfo: z.boolean().optional(),
    hostKinds: z
      .array(z.enum(["dns", "ipv4", "ipv6"]))
      .min(1)
      .max(3)
      .optional(),
    resolvedIpCidrs: z
      .array(z.string().min(3).max(64))
      .min(1)
      .max(256)
      .optional(),
    relaySelf: z.boolean().optional(),
    origins: z.array(StringMatcherV1Schema).min(1).max(64).optional(),
    hosts: z.array(StringMatcherV1Schema).min(1).max(64).optional(),
    ports: z
      .array(z.number().int().min(1).max(65_535))
      .min(1)
      .max(128)
      .optional(),
    path: z
      .object({
        representation: z.enum(["raw", "normalized"]),
        value: StringMatcherV1Schema,
      })
      .strict()
      .optional(),
    query: z.array(NamedValueMatcherV1Schema).max(64).optional(),
    headers: z.array(NamedValueMatcherV1Schema).max(64).optional(),
    body: BodyMatcherV1Schema.optional(),
    fetchOptions: z.array(FetchOptionMatcherV1Schema).max(32).optional(),
    redirect: z
      .object({
        minHops: z.number().int().nonnegative().optional(),
        maxHops: z.number().int().nonnegative().optional(),
        crossOrigin: z.boolean().optional(),
      })
      .strict()
      .optional(),
    websocketSubprotocols: z.array(StringMatcherV1Schema).max(32).optional(),
    sni: StringMatcherV1Schema.optional(),
    alpn: z.array(StringMatcherV1Schema).max(16).optional(),
  })
  .strict();
export type PolicyMatchV1 = z.infer<typeof PolicyMatchV1Schema>;

export const PolicyRuleV1Schema = z
  .object({
    id: z.string().min(1).max(128),
    name: z.string().min(1).max(256),
    enabled: z.boolean(),
    action: z.enum(["allow", "deny"]),
    match: PolicyMatchV1Schema,
  })
  .strict();
export type PolicyRuleV1 = z.infer<typeof PolicyRuleV1Schema>;

export const PolicySetV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    mode: z.enum(["allowlist", "blocklist"]),
    revision: z.number().int().nonnegative(),
    rules: z.array(PolicyRuleV1Schema).max(2_048),
  })
  .strict();
export type PolicySetV1 = z.infer<typeof PolicySetV1Schema>;

export const UserDenyRulesV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    rules: z.array(PolicyRuleV1Schema).max(512),
  })
  .strict()
  .superRefine((value, context) => {
    value.rules.forEach((rule, index) => {
      if (rule.action !== "deny") {
        context.addIssue({
          code: "custom",
          message: "User rules may only deny requests",
          path: ["rules", index, "action"],
        });
      }
    });
  });
export type UserDenyRulesV1 = z.infer<typeof UserDenyRulesV1Schema>;

export const PolicyHeaderSnapshotV1Schema = z
  .array(HeaderEntryV1Schema)
  .max(256);
