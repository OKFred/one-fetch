export const PROTOCOL_VERSION = 1 as const;

export const ONE_FETCH_REQUEST_HEADER = "One-Fetch-Request" as const;
export const ONE_FETCH_RESPONSE_HEADER = "One-Fetch-Response" as const;
export const ONE_FETCH_TOKEN_HEADER = "One-Fetch-Token" as const;
export const ONE_FETCH_WEBSOCKET_PROTOCOL = "one-fetch.v1" as const;

export const ONE_FETCH_LIMITS_V1 = Object.freeze({
  metadataBytes: 49_152,
  requestBodyBytes: 20_971_520,
  responseBodyBytes: 20_971_520,
  inspectableBodyBytes: 1_048_576,
  timeoutMs: 60_000,
  redirects: 20,
  headers: 256,
  headerNameBytes: 256,
  headerValueBytes: 16_384,
  tunnelHelloBytes: 49_152,
} as const);

export const ONE_FETCH_RESERVED_HEADER_NAMES = Object.freeze(
  new Set(
    [
      ONE_FETCH_REQUEST_HEADER,
      ONE_FETCH_RESPONSE_HEADER,
      ONE_FETCH_TOKEN_HEADER,
    ].map((name) => name.toLowerCase()),
  ),
);
