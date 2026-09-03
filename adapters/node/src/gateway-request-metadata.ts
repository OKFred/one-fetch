import type { IncomingMessage } from "node:http";

import {
  decodeRequestMetadata,
  ONE_FETCH_REQUEST_HEADER,
  type OneFetchRequestMetaV1,
} from "@one-fetch/protocol";

import { failure } from "./gateway-error.js";
import { reconcileContentType } from "./headers.js";

export const requireRequestMetadata = (
  request: IncomingMessage,
): OneFetchRequestMetaV1 => {
  const value = request.headers[ONE_FETCH_REQUEST_HEADER.toLowerCase()];
  const encoded = Array.isArray(value) ? value[0] : value;
  if (!encoded)
    throw failure(
      "invalid_metadata",
      "protocol",
      "Missing one-fetch request metadata",
      400,
    );
  let metadata: OneFetchRequestMetaV1;
  try {
    metadata = decodeRequestMetadata(encoded);
  } catch (error) {
    throw failure(
      error instanceof Error && error.message.includes("maximum")
        ? "metadata_too_large"
        : "invalid_metadata",
      "protocol",
      "Request metadata is invalid",
      400,
    );
  }
  const headers = reconcileContentType(
    metadata.targetHeaders,
    metadata.body.contentType,
  );
  if (!headers)
    throw failure(
      "invalid_metadata",
      "protocol",
      "Content-Type metadata must exactly match one non-empty target header",
      400,
    );
  return { ...metadata, targetHeaders: headers };
};
