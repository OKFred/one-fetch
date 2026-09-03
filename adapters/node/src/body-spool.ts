import { createReadStream } from "node:fs";
import { mkdir, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";

import { createHash } from "node:crypto";

import { randomId } from "./crypto.js";

export interface BodySpool {
  cleanup: () => Promise<void>;
  contentForPolicy?: Uint8Array;
  createStream: () => Readable | undefined;
  sha256: string;
  sizeBytes: number;
}

export const spoolBody = async (
  input: AsyncIterable<Uint8Array>,
  maximumBytes: number,
  inspectableBytes: number,
): Promise<BodySpool> => {
  const directory = join(tmpdir(), "one-fetch");
  await mkdir(directory, { recursive: true });
  const path = join(directory, `${randomId("body")}.bin`);
  const handle = await open(path, "wx", 0o600);
  const hash = createHash("sha256");
  const inspectionChunks: Uint8Array[] = [];
  let inspectionSize = 0;
  let sizeBytes = 0;
  try {
    for await (const chunk of input) {
      sizeBytes += chunk.byteLength;
      if (sizeBytes > maximumBytes)
        throw new Error(`Request body exceeds ${maximumBytes} bytes`);
      hash.update(chunk);
      await handle.write(chunk);
      if (inspectionSize < inspectableBytes) {
        const remaining = inspectableBytes - inspectionSize;
        const selected = chunk.subarray(0, remaining);
        inspectionChunks.push(selected);
        inspectionSize += selected.byteLength;
      }
    }
  } catch (error) {
    await handle.close();
    await rm(path, { force: true });
    throw error;
  }
  await handle.sync();
  await handle.close();
  const inspection = Buffer.concat(inspectionChunks);
  return {
    cleanup: async () => rm(path, { force: true }),
    ...(sizeBytes <= inspectableBytes ? { contentForPolicy: inspection } : {}),
    createStream: () => (sizeBytes === 0 ? undefined : createReadStream(path)),
    sha256: hash.digest("hex"),
    sizeBytes,
  };
};
