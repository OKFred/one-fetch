import {
  AuditRedactionConfigV1Schema,
  UnsignedAuditEventV1Schema,
  type AuditHeaderV1,
  type AuditRedactionConfigV1,
  type UnsignedAuditEventV1,
} from "@one-fetch/protocol";

const NEVER_LOG_HEADERS = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "one-fetch-token",
]);

export const DEFAULT_AUDIT_REDACTION_CONFIG: AuditRedactionConfigV1 = {
  replacement: "[REDACTED]",
  sensitiveNames: [
    "token",
    "access_token",
    "refresh_token",
    "api_key",
    "apikey",
    "key",
    "secret",
    "signature",
    "password",
    "passwd",
    "session",
    "credential",
  ],
  pathSegmentIndexes: [],
  preserveQueryNames: true,
};

function clean(value: string, maximum: number): string {
  return value
    .replaceAll("\r", " ")
    .replaceAll("\n", " ")
    .replaceAll("\u0000", " ")
    .slice(0, maximum);
}

function isSensitiveName(
  name: string,
  config: AuditRedactionConfigV1,
): boolean {
  const normalized = name.toLocaleLowerCase("en-US");
  return config.sensitiveNames.some((candidate) =>
    normalized.includes(candidate.toLocaleLowerCase("en-US")),
  );
}

function looksLikeSecret(value: string): boolean {
  if (value.length < 32 || /\s/u.test(value)) return false;
  const classes = [/[a-z]/u, /[A-Z]/u, /[0-9]/u, /[^A-Za-z0-9]/u].filter(
    (expression) => expression.test(value),
  ).length;
  return classes >= 3 || /^[A-Za-z0-9_-]{40,}$/u.test(value);
}

function redactHeaders(
  headers: AuditHeaderV1[],
  config: AuditRedactionConfigV1,
): AuditHeaderV1[] {
  return headers
    .filter(
      ({ name }) => !NEVER_LOG_HEADERS.has(name.toLocaleLowerCase("en-US")),
    )
    .map(({ name, value }) => ({
      name: clean(name, 256),
      value:
        isSensitiveName(name, config) || looksLikeSecret(value)
          ? config.replacement
          : clean(value, 2_048),
    }));
}

function redactPath(path: string, config: AuditRedactionConfigV1): string {
  const segments = clean(path, 8_192).split("/");
  for (const index of config.pathSegmentIndexes) {
    const actual = path.startsWith("/") ? index + 1 : index;
    if (actual < segments.length) segments[actual] = config.replacement;
  }
  return segments.join("/");
}

export function redactAuditEvent(
  event: UnsignedAuditEventV1,
  inputConfig: AuditRedactionConfigV1 = DEFAULT_AUDIT_REDACTION_CONFIG,
): UnsignedAuditEventV1 {
  const config = AuditRedactionConfigV1Schema.parse(inputConfig);
  const parsed = UnsignedAuditEventV1Schema.parse(event);
  if (parsed.request === undefined) return parsed;
  const request = parsed.request;
  return UnsignedAuditEventV1Schema.parse({
    ...parsed,
    request: {
      ...request,
      ...(request.origin === undefined
        ? {}
        : { origin: clean(request.origin, 2_048) }),
      ...(request.path === undefined
        ? {}
        : { path: redactPath(request.path, config) }),
      ...(request.query === undefined
        ? {}
        : {
            query: request.query.map(([name, value]) => [
              clean(name, 1_024),
              isSensitiveName(name, config) || looksLikeSecret(value)
                ? config.replacement
                : config.preserveQueryNames
                  ? clean(value, 4_096)
                  : config.replacement,
            ]),
          }),
      ...(request.headers === undefined
        ? {}
        : { headers: redactHeaders(request.headers, config) }),
    },
  });
}
