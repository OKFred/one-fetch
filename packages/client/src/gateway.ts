import {
  ONE_FETCH_LIMITS_V1,
  ONE_FETCH_REQUEST_HEADER,
  ONE_FETCH_RESPONSE_HEADER,
  ONE_FETCH_TOKEN_HEADER,
  OneFetchRequestMetaV1Schema,
  encodeRequestMetadata,
  type FetchOptionCapabilityV1,
  type FetchOptionsV1,
  type HeaderEntryV1,
  type OneFetchRequestMetaV1,
} from "@one-fetch/protocol";
import {
  classifyFetchOptions,
  classifyOneFetchResponse,
  randomNonce,
  type FetchOptionsClassification,
  type OneFetchResponseClassification,
} from "@one-fetch/core";

import { buildGatewayUrl, parseServiceOrigin } from "./url.js";

export type GatewayProgressPhase =
  | "preparing"
  | "uploading"
  | "waiting"
  | "downloading"
  | "cancelling"
  | "complete";

export interface GatewayProgress {
  phase: GatewayProgressPhase;
  loadedBytes: number;
  totalBytes?: number;
  elapsedMs: number;
}

export interface GatewayHttpRequest {
  targetUrl: string;
  method: string;
  headers?: HeaderEntryV1[];
  body?: BodyInit | null;
  bodySizeBytes?: number;
  bodySha256?: string;
  contentType?: string;
  fetchOptions?: Partial<FetchOptionsV1>;
  userDenyRules?: OneFetchRequestMetaV1["userDenyRules"];
  requestId?: string;
  signal?: AbortSignal;
  onProgress?: (progress: GatewayProgress) => void;
}

export interface GatewayHttpResult {
  response: Response;
  requestMetadata: OneFetchRequestMetaV1;
  classification: OneFetchResponseClassification;
  optionClassification?: FetchOptionsClassification;
}

export interface OneFetchGatewayClientOptions {
  gatewayUrl: string;
  token: string;
  fetch?: typeof globalThis.fetch;
  capabilities?: FetchOptionCapabilityV1[];
  client?: { name: string; version: string };
}

function bodyContentType(
  headers: HeaderEntryV1[],
  explicit: string | undefined,
): string | undefined {
  return (
    explicit ??
    headers.find(({ name }) => name.toLowerCase() === "content-type")?.value
  );
}

function withUrlUserinfoHeader(
  target: URL,
  headers: HeaderEntryV1[],
): HeaderEntryV1[] {
  if (target.username === "" && target.password === "") return headers;
  if (headers.some(({ name }) => name.toLowerCase() === "authorization")) {
    throw new TypeError(
      "Target URL userinfo conflicts with an explicit Authorization header",
    );
  }
  const username = decodeURIComponent(target.username);
  const password = decodeURIComponent(target.password);
  const bytes = new TextEncoder().encode(`${username}:${password}`);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const credentials = btoa(binary);
  return [...headers, { name: "Authorization", value: `Basic ${credentials}` }];
}

function composeAbortSignal(
  parent: AbortSignal | undefined,
  timeoutMs: number,
): {
  signal: AbortSignal;
  cleanup: () => void;
} {
  const controller = new AbortController();
  const abort = (): void =>
    controller.abort(
      parent?.reason ?? new DOMException("Request cancelled", "AbortError"),
    );
  if (parent?.aborted === true) abort();
  else parent?.addEventListener("abort", abort, { once: true });
  const timer = globalThis.setTimeout(
    () =>
      controller.abort(
        new DOMException(`Request exceeded ${timeoutMs} ms`, "TimeoutError"),
      ),
    timeoutMs,
  );
  return {
    signal: controller.signal,
    cleanup: () => {
      globalThis.clearTimeout(timer);
      parent?.removeEventListener("abort", abort);
    },
  };
}

export class OneFetchGatewayClient {
  readonly gatewayOrigin: string;
  readonly #token: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #capabilities: FetchOptionCapabilityV1[] | undefined;
  readonly #client: { name: string; version: string } | undefined;

  constructor(options: OneFetchGatewayClientOptions) {
    this.gatewayOrigin = parseServiceOrigin(
      options.gatewayUrl,
      "Gateway URL",
    ).origin;
    if (options.token.length < 16)
      throw new TypeError("Execution token is too short");
    this.#token = options.token;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#capabilities = options.capabilities;
    this.#client = options.client;
  }

  async executeHttp(input: GatewayHttpRequest): Promise<GatewayHttpResult> {
    const startedAt = performance.now();
    const progress = (
      phase: GatewayProgressPhase,
      loadedBytes = 0,
      totalBytes = input.bodySizeBytes,
    ): void => {
      input.onProgress?.({
        phase,
        loadedBytes,
        ...(totalBytes === undefined ? {} : { totalBytes }),
        elapsedMs: performance.now() - startedAt,
      });
    };
    progress("preparing");
    const target = new URL(input.targetUrl);
    const gatewayUrl = buildGatewayUrl(this.gatewayOrigin, target.href);
    const method = input.method.toUpperCase();
    if ((method === "GET" || method === "HEAD") && input.body != null) {
      throw new TypeError(`${method} requests cannot carry a body`);
    }
    const targetHeaders = withUrlUserinfoHeader(target, input.headers ?? []);
    const fetchOptions: FetchOptionsV1 = {
      redirect: input.fetchOptions?.redirect ?? "follow",
      timeoutMs: input.fetchOptions?.timeoutMs ?? ONE_FETCH_LIMITS_V1.timeoutMs,
      ...input.fetchOptions,
    };
    const optionClassification =
      this.#capabilities === undefined
        ? undefined
        : classifyFetchOptions(fetchOptions, this.#capabilities);
    if (optionClassification !== undefined && !optionClassification.allowed) {
      const names = optionClassification.assessments
        .filter(({ fidelity }) => fidelity === "unsupported")
        .map(({ option }) => option)
        .join(", ");
      throw new TypeError(
        `Gateway does not support these Fetch options: ${names}`,
      );
    }
    const requestId = input.requestId ?? globalThis.crypto.randomUUID();
    const metadata = OneFetchRequestMetaV1Schema.parse({
      protocolVersion: 1,
      requestId,
      nonce: randomNonce(),
      transport: "http",
      targetOrigin: target.origin,
      targetUrlTraits: {
        hasUserinfo: target.username !== "" || target.password !== "",
      },
      targetHeaders,
      fetchOptions,
      ...(input.userDenyRules === undefined
        ? {}
        : { userDenyRules: input.userDenyRules }),
      body: {
        ...(input.bodySizeBytes === undefined
          ? {}
          : { sizeBytes: input.bodySizeBytes }),
        ...(input.bodySha256 === undefined ? {} : { sha256: input.bodySha256 }),
        ...(bodyContentType(targetHeaders, input.contentType) === undefined
          ? {}
          : { contentType: bodyContentType(targetHeaders, input.contentType) }),
      },
      hop: 0,
      ...(this.#client === undefined ? {} : { client: this.#client }),
    });
    const abort = composeAbortSignal(input.signal, fetchOptions.timeoutMs);
    try {
      progress("uploading");
      const responsePromise = this.#fetch(gatewayUrl, {
        method,
        headers: {
          [ONE_FETCH_REQUEST_HEADER]: encodeRequestMetadata(metadata),
          [ONE_FETCH_TOKEN_HEADER]: this.#token,
        },
        ...(input.body == null ? {} : { body: input.body }),
        redirect: "manual",
        signal: abort.signal,
      });
      progress("waiting", input.bodySizeBytes ?? 0);
      const response = await responsePromise;
      progress("downloading", 0, undefined);
      const classification = await classifyOneFetchResponse(
        response.headers.get(ONE_FETCH_RESPONSE_HEADER),
        {
          token: this.#token,
          requestId: metadata.requestId,
          nonce: metadata.nonce,
        },
      );
      if (
        classification.source === "target" &&
        (classification.target.kind !== "http" ||
          classification.target.status !== response.status)
      ) {
        return {
          response,
          requestMetadata: metadata,
          ...(optionClassification === undefined
            ? {}
            : { optionClassification }),
          classification: {
            source: "intermediary",
            reason: "identity-mismatch",
          },
        };
      }
      progress("complete", input.bodySizeBytes ?? 0, input.bodySizeBytes);
      return {
        response,
        requestMetadata: metadata,
        classification,
        ...(optionClassification === undefined ? {} : { optionClassification }),
      };
    } catch (error) {
      if (abort.signal.aborted) progress("cancelling");
      throw error;
    } finally {
      abort.cleanup();
    }
  }
}
