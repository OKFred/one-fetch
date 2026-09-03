import {
  BootstrapRequestV1Schema,
  ChangePasswordRequestV1Schema,
  CreateExecutionTokenRequestV1Schema,
  LoginRequestV1Schema,
  RefreshRequestV1Schema,
  SetGatewayPausedRequestV1Schema,
  TotpEnableRequestV1Schema,
  UpdatePolicyRequestV1Schema,
} from "@one-fetch/protocol";

import { ADMIN_USERNAME_PATTERN } from "./auth-types";

export const bootstrapSchema = BootstrapRequestV1Schema.refine(
  ({ username }) => ADMIN_USERNAME_PATTERN.test(username),
  { message: "Invalid administrator username", path: ["username"] },
);
export const loginSchema = LoginRequestV1Schema.refine(
  ({ username }) => ADMIN_USERNAME_PATTERN.test(username),
  { message: "Invalid administrator username", path: ["username"] },
);
export const refreshSchema = RefreshRequestV1Schema;
export const totpEnableSchema = TotpEnableRequestV1Schema;
export const passwordChangeSchema = ChangePasswordRequestV1Schema;

export const executionTokenSchema = CreateExecutionTokenRequestV1Schema;
export const policyUpdateSchema = UpdatePolicyRequestV1Schema;
export const gatewayPausedSchema = SetGatewayPausedRequestV1Schema;

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
