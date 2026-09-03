import { z } from "zod";
import {
  BootstrapRequestV1Schema,
  CreateExecutionTokenRequestV1Schema,
  LoginRequestV1Schema,
  RefreshRequestV1Schema,
} from "@one-fetch/protocol";

export const bootstrapSchema = BootstrapRequestV1Schema;
export const loginSchema = LoginRequestV1Schema;
export const refreshSchema = RefreshRequestV1Schema;
export const totpCodeSchema = z
  .object({ code: z.string().regex(/^\d{6}$/u) })
  .strict();
export const passwordChangeSchema = z
  .object({
    currentPassword: z.string().min(1).max(1_024),
    nextPassword: z.string().min(12).max(1_024),
  })
  .strict();

export const executionTokenSchema = CreateExecutionTokenRequestV1Schema;

export const configUpdateSchema = z.object({ config: z.unknown() }).strict();

export async function readBoundedJson(
  request: Request,
  limitBytes = 1_048_576,
): Promise<unknown> {
  const declared = request.headers.get("content-length");
  if (declared && Number.parseInt(declared, 10) > limitBytes)
    throw new Error("payload_too_large");
  if (!request.body) return {};
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    length += result.value.byteLength;
    if (length > limitBytes) {
      await reader.cancel("payload_too_large");
      throw new Error("payload_too_large");
    }
    chunks.push(result.value);
  }
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(body)) as unknown;
}
