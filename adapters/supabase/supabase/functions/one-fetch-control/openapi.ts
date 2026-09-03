import { z } from "zod";

import { CONTROL_OPENAPI_JSON } from "../_shared/control-openapi.generated.ts";
import { requestPath } from "../_shared/http.ts";

export const CONTROL_BASE_URL_HEADER = "x-one-fetch-runtime-control-base";

const OpenApiDocumentSchema = z
  .object({
    openapi: z.literal("3.1.0"),
    paths: z.record(z.string(), z.unknown()),
  })
  .loose();

const CANONICAL_DOCUMENT = OpenApiDocumentSchema.parse(
  JSON.parse(CONTROL_OPENAPI_JSON),
);

type OpenApiOperation = {
  responses: Record<string, unknown>;
};

type MutableOpenApiDocument = z.infer<typeof OpenApiDocumentSchema> & {
  servers?: { url: string; description?: string }[];
};

export function deriveControlBaseUrl(request: Request): string {
  const url = new URL(request.url);
  const routePath = requestPath(request, "one-fetch-control");
  const basePath = url.pathname.endsWith(routePath)
    ? url.pathname.slice(0, -routePath.length)
    : "";
  const normalizedPath = basePath.replace(/\/$/u, "");
  return `${url.origin}${normalizedPath}`;
}

function postOperation(
  document: MutableOpenApiDocument,
  path: string,
): OpenApiOperation {
  const pathItem = document.paths[path];
  if (!pathItem || typeof pathItem !== "object") {
    throw new Error(`Canonical OpenAPI is missing ${path}`);
  }
  const operation = (pathItem as { post?: unknown }).post;
  if (!operation || typeof operation !== "object") {
    throw new Error(`Canonical OpenAPI is missing POST ${path}`);
  }
  const responses = (operation as { responses?: unknown }).responses;
  if (!responses || typeof responses !== "object") {
    throw new Error(`Canonical OpenAPI is missing responses for ${path}`);
  }
  return operation as OpenApiOperation;
}

function addAdapterErrorResponse(
  document: MutableOpenApiDocument,
  path: string,
  status: string,
  description: string,
): void {
  const operation = postOperation(document, path);
  const unauthorized = operation.responses["401"];
  if (!unauthorized || typeof unauthorized !== "object") {
    throw new Error(`Canonical OpenAPI is missing the 401 schema for ${path}`);
  }
  operation.responses[status] = {
    ...structuredClone(unauthorized),
    description,
  };
}

function markTotpUnsupported(
  document: MutableOpenApiDocument,
  path: string,
): void {
  const operation = postOperation(document, path);
  const unauthorized = operation.responses["401"];
  if (!unauthorized || typeof unauthorized !== "object") {
    throw new Error(`Canonical OpenAPI is missing the 401 schema for ${path}`);
  }
  operation.responses = {
    "401": unauthorized,
    "501": {
      ...structuredClone(unauthorized),
      description:
        "TOTP enrollment is not implemented by the Supabase Preview adapter",
    },
  };
}

export function createSupabaseOpenApi(request: Request): unknown {
  const document = structuredClone(
    CANONICAL_DOCUMENT,
  ) as MutableOpenApiDocument;
  document.servers = [
    {
      url:
        request.headers.get(CONTROL_BASE_URL_HEADER) ??
        deriveControlBaseUrl(request),
      description: "This Supabase Control Edge Function base URL",
    },
  ];
  markTotpUnsupported(document, "/api/v1/auth/totp/prepare");
  markTotpUnsupported(document, "/api/v1/auth/totp/enable");
  addAdapterErrorResponse(
    document,
    "/api/v1/auth/login",
    "501",
    "TOTP login is not implemented by the Supabase Preview adapter",
  );
  addAdapterErrorResponse(
    document,
    "/api/v1/auth/password",
    "409",
    "Administrator credentials changed concurrently",
  );
  return document;
}
