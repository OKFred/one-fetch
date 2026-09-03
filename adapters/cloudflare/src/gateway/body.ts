import type { PolicyBodyContext } from "@one-fetch/core";

import { problem } from "./errors";

export interface PreparedBody {
  body: ReadableStream<Uint8Array> | null;
  policy: PolicyBodyContext;
  getUploadedBytes(): number;
}

export async function prepareRequestBody(
  body: ReadableStream<Uint8Array> | null,
  declaredSize: number | undefined,
  contentType: string | undefined,
  inspectionLimit: number,
  requestLimit: number,
): Promise<PreparedBody> {
  if (declaredSize !== undefined && declaredSize > requestLimit) {
    throw problem(
      "payload_too_large",
      "upload",
      "The declared request body exceeds the configured limit",
      413,
    );
  }
  if (!body) {
    return {
      body: null,
      policy: {
        availability: "available",
        bytes: new Uint8Array(),
        sizeBytes: 0,
        ...(contentType ? { contentType } : {}),
      },
      getUploadedBytes: () => 0,
    };
  }

  let policy: PolicyBodyContext;
  let forward: ReadableStream<Uint8Array>;
  if (declaredSize !== undefined && declaredSize > inspectionLimit) {
    forward = body;
    policy = {
      availability: "too-large",
      sizeBytes: declaredSize,
      ...(contentType ? { contentType } : {}),
    };
  } else {
    const [inspect, forwarding] = body.tee();
    forward = forwarding;
    const inspected = await readAtMost(inspect, inspectionLimit);
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
    getUploadedBytes: () => uploadedBytes,
  };
}

async function readAtMost(
  stream: ReadableStream<Uint8Array>,
  limit: number,
): Promise<{ complete: boolean; bytes: Uint8Array }> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const result = await reader.read();
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

function concatenate(chunks: Uint8Array[], size: number): Uint8Array {
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}
