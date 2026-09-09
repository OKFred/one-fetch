import { decodedMetadataByteLength } from "@one-fetch/protocol";

export function metadataExceedsAdapterLimit(
  encoded: string,
  maxDecodedBytes: number,
): boolean {
  return decodedMetadataByteLength(encoded) > maxDecodedBytes;
}
