import {
  ONE_FETCH_LIMITS_V1,
  type BodyMatcherV1,
  type NamedValueMatcherV1,
  type StringMatcherV1,
} from "@one-fetch/protocol";

import type { PolicyBodyContext } from "./policy-types.js";

function escapeRegex(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/gu, "\\$&");
}

function globMatches(
  pattern: string,
  value: string,
  caseSensitive: boolean,
): boolean {
  const expression = `^${escapeRegex(pattern).replaceAll("*", ".*")}$`;
  return new RegExp(expression, caseSensitive ? "u" : "iu").test(value);
}

export function matchString(
  matcher: StringMatcherV1,
  candidate: string,
  forceInsensitive = false,
): boolean {
  const caseSensitive = forceInsensitive
    ? false
    : (matcher.caseSensitive ?? true);
  const expected = caseSensitive
    ? matcher.value
    : matcher.value.toLocaleLowerCase("en-US");
  const actual = caseSensitive
    ? candidate
    : candidate.toLocaleLowerCase("en-US");
  switch (matcher.operator) {
    case "exact":
      return actual === expected;
    case "prefix":
      return actual.startsWith(expected);
    case "suffix":
      return actual.endsWith(expected);
    case "contains":
      return actual.includes(expected);
    case "glob":
      return globMatches(matcher.value, candidate, caseSensitive);
  }
}

export function matchNamedValue(
  matcher: NamedValueMatcherV1,
  values: ReadonlyArray<readonly [string, string]>,
  namesCaseInsensitive: boolean,
): boolean {
  const candidates = values.filter(([name]) =>
    matchString(matcher.name, name, namesCaseInsensitive),
  );
  if (matcher.presence === "absent") return candidates.length === 0;
  if (candidates.length === 0) return false;
  return (
    matcher.value === undefined ||
    candidates.some(([, value]) => matchString(matcher.value!, value))
  );
}

function jsonPointer(
  root: unknown,
  pointer: string,
): { found: boolean; value?: unknown } {
  if (pointer === "") return { found: true, value: root };
  let current = root;
  for (const raw of pointer.slice(1).split("/")) {
    const segment = raw.replaceAll("~1", "/").replaceAll("~0", "~");
    if (current === null || typeof current !== "object")
      return { found: false };
    if (Array.isArray(current)) {
      if (!/^(0|[1-9][0-9]*)$/u.test(segment)) return { found: false };
      const index = Number(segment);
      if (index >= current.length) return { found: false };
      current = current[index];
    } else {
      if (!Object.prototype.hasOwnProperty.call(current, segment))
        return { found: false };
      current = (current as Record<string, unknown>)[segment];
    }
  }
  return { found: true, value: current };
}

function contentTypeBase(value: string | undefined): string {
  return value?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

function textBody(context: PolicyBodyContext): string | undefined {
  if (
    context.availability !== "available" ||
    context.bytes === undefined ||
    context.bytes.byteLength > ONE_FETCH_LIMITS_V1.inspectableBodyBytes
  ) {
    return undefined;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(context.bytes);
  } catch {
    return undefined;
  }
}

export interface BodyMatchResult {
  matches: boolean;
  unavailableDeny: boolean;
  warning?: string;
}

function unavailableBody(matcher: BodyMatcherV1): BodyMatchResult {
  return {
    matches: false,
    unavailableDeny: matcher.onUnavailable === "deny",
    warning: `Body rule ${matcher.kind} could not be evaluated`,
  };
}

function matchJsonBody(
  matcher: Extract<BodyMatcherV1, { kind: "json" }>,
  body: PolicyBodyContext,
): BodyMatchResult {
  if (
    contentTypeBase(body.contentType) !== "application/json" &&
    !contentTypeBase(body.contentType).endsWith("+json")
  ) {
    return { matches: false, unavailableDeny: false };
  }
  const text = textBody(body);
  if (text === undefined) return unavailableBody(matcher);
  try {
    const result = jsonPointer(JSON.parse(text), matcher.pointer);
    if (matcher.operator === "exists")
      return { matches: result.found, unavailableDeny: false };
    if (!result.found) return { matches: false, unavailableDeny: false };
    if (matcher.operator === "equals") {
      return {
        matches: Object.is(result.value, matcher.value),
        unavailableDeny: false,
      };
    }
    return {
      matches:
        typeof result.value === "string" &&
        matcher.string !== undefined &&
        matchString(matcher.string, result.value),
      unavailableDeny: false,
    };
  } catch {
    return unavailableBody(matcher);
  }
}

function matchFormBody(
  matcher: Extract<BodyMatcherV1, { kind: "form" }>,
  body: PolicyBodyContext,
): BodyMatchResult {
  if (
    contentTypeBase(body.contentType) !== "application/x-www-form-urlencoded"
  ) {
    return { matches: false, unavailableDeny: false };
  }
  const text = textBody(body);
  if (text === undefined) return unavailableBody(matcher);
  return {
    matches: matchNamedValue(
      matcher.field,
      Array.from(new URLSearchParams(text).entries()),
      false,
    ),
    unavailableDeny: false,
  };
}

interface MultipartPart {
  name: string;
  filename?: string;
  contentType?: string;
  text: string;
}

function parseMultipart(
  text: string,
  contentType: string,
): MultipartPart[] | undefined {
  const boundary = /(?:^|;)\s*boundary=(?:"([^"]+)"|([^;\s]+))/iu
    .exec(contentType)
    ?.slice(1)
    .find(Boolean);
  if (boundary === undefined || boundary.length > 200) return undefined;
  const parts: MultipartPart[] = [];
  for (const raw of text.split(`--${boundary}`).slice(1)) {
    if (raw.startsWith("--")) break;
    const normalized = raw.replace(/^\r?\n/u, "");
    const separator = normalized.indexOf("\r\n\r\n");
    if (separator < 0) continue;
    const headers = normalized.slice(0, separator).split("\r\n");
    const disposition = headers.find((line) =>
      line.toLowerCase().startsWith("content-disposition:"),
    );
    const name = /(?:^|;)\s*name="([^"]*)"/iu.exec(disposition ?? "")?.[1];
    if (name === undefined) continue;
    const filename = /(?:^|;)\s*filename="([^"]*)"/iu.exec(
      disposition ?? "",
    )?.[1];
    const partContentType = headers
      .find((line) => line.toLowerCase().startsWith("content-type:"))
      ?.slice(13)
      .trim();
    const partText = normalized.slice(separator + 4).replace(/\r\n$/u, "");
    parts.push({
      name,
      ...(filename === undefined ? {} : { filename }),
      ...(partContentType === undefined
        ? {}
        : { contentType: partContentType }),
      text: partText,
    });
  }
  return parts;
}

function matchMultipartBody(
  matcher: Extract<BodyMatcherV1, { kind: "multipart" }>,
  body: PolicyBodyContext,
): BodyMatchResult {
  if (contentTypeBase(body.contentType) !== "multipart/form-data")
    return { matches: false, unavailableDeny: false };
  const text = textBody(body);
  const parts =
    text === undefined
      ? undefined
      : parseMultipart(text, body.contentType ?? "");
  if (parts === undefined) return unavailableBody(matcher);
  return {
    matches: parts.some(
      (part) =>
        matchString(matcher.partName, part.name) &&
        (matcher.filename === undefined ||
          (part.filename !== undefined &&
            matchString(matcher.filename, part.filename))) &&
        (matcher.contentType === undefined ||
          (part.contentType !== undefined &&
            matchString(matcher.contentType, part.contentType, true))) &&
        (matcher.text === undefined ||
          (part.filename === undefined &&
            matchString(matcher.text, part.text))),
    ),
    unavailableDeny: false,
  };
}

export function matchPolicyBody(
  matcher: BodyMatcherV1,
  body: PolicyBodyContext,
): BodyMatchResult {
  if (matcher.kind === "json") return matchJsonBody(matcher, body);
  if (matcher.kind === "form") return matchFormBody(matcher, body);
  if (matcher.kind === "multipart") return matchMultipartBody(matcher, body);
  if (matcher.kind === "text") {
    const text = textBody(body);
    return text === undefined
      ? unavailableBody(matcher)
      : { matches: matchString(matcher.value, text), unavailableDeny: false };
  }
  const size = body.sizeBytes ?? body.bytes?.byteLength;
  const matches =
    size !== undefined &&
    (matcher.minBytes === undefined || size >= matcher.minBytes) &&
    (matcher.maxBytes === undefined || size <= matcher.maxBytes) &&
    (matcher.contentType === undefined ||
      matchString(matcher.contentType, body.contentType ?? "", true));
  return size === undefined
    ? unavailableBody(matcher)
    : { matches, unavailableDeny: false };
}
