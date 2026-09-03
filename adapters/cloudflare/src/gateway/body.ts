import { sha256Hex, type PolicyBodyContext } from "@one-fetch/core";

import { problem } from "./errors";

export interface PreparedBody {
  body: ReadableStream<Uint8Array> | null;
  policy: PolicyBodyContext;
  sizeBytes?: number;
  getUploadedBytes(): number;
}

export async function prepareRequestBody(
  body: ReadableStream<Uint8Array> | null,
  declaredSize: number | undefined,
  transportSize: number | undefined,
  expectedSha256: string | undefined,
  contentType: string | undefined,
  inspectionLimit: number,
  requestLimit: number,
  signal?: AbortSignal,
): Promise<PreparedBody> {
  if (
    (declaredSize !== undefined && declaredSize > requestLimit) ||
    (transportSize !== undefined && transportSize > requestLimit)
  ) {
    throw problem(
      "payload_too_large",
      "upload",
      "The declared request body exceeds the configured limit",
      413,
    );
  }
  if (!body) {
    const empty = new Uint8Array();
    await validateMetadata(empty, declaredSize, transportSize, expectedSha256);
    return {
      body: null,
      policy: {
        availability: "available",
        bytes: new Uint8Array(),
        sizeBytes: 0,
        ...(contentType ? { contentType } : {}),
      },
      sizeBytes: 0,
      getUploadedBytes: () => 0,
    };
  }

  let policy: PolicyBodyContext;
  let forward: ReadableStream<Uint8Array>;
  let sizeBytes: number | undefined;
  if (
    declaredSize !== undefined ||
    transportSize !== undefined ||
    expectedSha256 !== undefined
  ) {
    const bytes = await readAll(body, requestLimit, signal);
    await validateMetadata(bytes, declaredSize, transportSize, expectedSha256);
    sizeBytes = bytes.byteLength;
    forward = streamBytes(bytes);
    policy =
      bytes.byteLength <= inspectionLimit
        ? {
            availability: "available",
            bytes,
            sizeBytes: bytes.byteLength,
            ...(contentType ? { contentType } : {}),
          }
        : {
            availability: "too-large",
            sizeBytes: bytes.byteLength,
            ...(contentType ? { contentType } : {}),
          };
  } else {
    const [inspect, forwarding] = body.tee();
    forward = forwarding;
    const inspected = await readAtMost(inspect, inspectionLimit, signal);
    policy = inspected.complete
      ? {
          availability: "available",
          bytes: inspected.bytes,
          sizeBytes: inspected.bytes.byteLength,
          ...(contentType ? { contentType } : {}),
        }
      : {
          availability: "too-large",
          ...(declaredSize === undefined ? {} : { sizeBytes: declaredSize }),
          ...(contentType ? { contentType } : {}),
        };
  }

  let uploadedBytes = 0;
  const limiter = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      uploadedBytes += chunk.byteLength;
      if (uploadedBytes > requestLimit) {
        controller.error(
          problem(
            "payload_too_large",
            "upload",
            "The request body exceeds the configured limit",
            413,
          ),
        );
        return;
      }
      controller.enqueue(chunk);
    },
  });
  return {
    body: forward.pipeThrough(limiter),
    policy,
    ...(sizeBytes === undefined ? {} : { sizeBytes }),
    getUploadedBytes: () => uploadedBytes,
  };
}

async function validateMetadata(
  bytes: Uint8Array,
  declaredSize: number | undefined,
  transportSize: number | undefined,
  expectedSha256: string | undefined,
): Promise<void> {
  if (declaredSize !== undefined && declaredSize !== bytes.byteLength) {
    throw problem(
      "invalid_metadata",
      "upload",
      "Declared request body size does not match payload",
      400,
    );
  }
  if (transportSize !== undefined && transportSize !== bytes.byteLength) {
    throw problem(
      "invalid_metadata",
      "upload",
      "Transport Content-Length does not match payload",
      400,
    );
  }
  if (
    expectedSha256 !== undefined &&
    (await sha256Hex(bytes)) !== expectedSha256
  ) {
    throw problem(
      "invalid_metadata",
      "upload",
      "Request body digest does not match payload",
      400,
    );
  }
}

async function readAll(
  stream: ReadableStream<Uint8Array>,
  limit: number,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const result = await readNext(reader, signal);
    if (result.done) return concatenate(chunks, size);
    size += result.value.byteLength;
    if (size > limit) {
      await reader.cancel("request_limit");
      throw problem(
        "payload_too_large",
        "upload",
        "The request body exceeds the configured limit",
        413,
      );
    }
    chunks.push(result.value);
  }
}

function streamBytes(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      if (bytes.byteLength > 0) controller.enqueue(bytes);
      controller.close();
    },
  });
}

async function readAtMost(
  stream: ReadableStream<Uint8Array>,
  limit: number,
  signal?: AbortSignal,
): Promise<{ complete: boolean; bytes: Uint8Array }> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const result = await readNext(reader, signal);
    if (result.done)
      return { complete: true, bytes: concatenate(chunks, size) };
    size += result.value.byteLength;
    if (size > limit) {
      await reader.cancel("inspection_limit");
      return { complete: false, bytes: new Uint8Array() };
    }
    chunks.push(result.value);
  }
}

async function readNext(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal?: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (signal === undefined) return reader.read();
  if (signal.aborted) {
    await reader.cancel(signal.reason).catch(() => undefined);
    throw abortReason(signal.reason);
  }
  return new Promise((resolve, reject) => {
    const aborted = (): void => {
      void reader.cancel(signal.reason).catch(() => undefined);
      reject(abortReason(signal.reason));
    };
    signal.addEventListener("abort", aborted, { once: true });
    void reader
      .read()
      .then(resolve, reject)
      .finally(() => {
        signal.removeEventListener("abort", aborted);
      });
  });
}

function abortReason(reason: unknown): Error {
  return reason instanceof Error
    ? reason
    : new DOMException("Request aborted", "AbortError");
}

function concatenate(chunks: Uint8Array[], size: number): Uint8Array {
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}
