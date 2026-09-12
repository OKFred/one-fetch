import type {
  AuditEventV1Schema,
  FetchOptionCapabilityV1Schema,
  HeaderEntryV1Schema,
  HeaderMutationNoticeV1Schema,
  JsonValueSchema,
  OneFetchCapabilitiesV1Schema,
  OneFetchProblemV1Schema,
  OneFetchRequestMetaV1Schema,
  OneFetchTimingV1Schema,
  OneFetchUnsignedResponseMetaV1Schema,
  PolicySetV1Schema,
  ServerTimingMetricV1Schema,
  UnsignedAuditEventV1Schema,
} from "@one-fetch/protocol";
import type { z } from "zod";

export type AuditEventV1 = z.infer<typeof AuditEventV1Schema>;
export type FetchOptionCapabilityV1 = z.infer<
  typeof FetchOptionCapabilityV1Schema
>;
export type HeaderEntryV1 = z.infer<typeof HeaderEntryV1Schema>;
export type HeaderMutationNoticeV1 = z.infer<
  typeof HeaderMutationNoticeV1Schema
>;
export type JsonValue = z.infer<typeof JsonValueSchema>;
export type PolicySetV1 = z.infer<typeof PolicySetV1Schema>;
export type OneFetchCapabilitiesV1 = z.infer<
  typeof OneFetchCapabilitiesV1Schema
>;
export type OneFetchProblemV1 = z.infer<typeof OneFetchProblemV1Schema>;
export type OneFetchRequestMetaV1 = z.infer<typeof OneFetchRequestMetaV1Schema>;
export type OneFetchTimingV1 = z.infer<typeof OneFetchTimingV1Schema>;
export type OneFetchUnsignedResponseMetaV1 = z.infer<
  typeof OneFetchUnsignedResponseMetaV1Schema
>;
export type ServerTimingMetricV1 = z.infer<typeof ServerTimingMetricV1Schema>;
export type UnsignedAuditEventV1 = z.infer<typeof UnsignedAuditEventV1Schema>;
