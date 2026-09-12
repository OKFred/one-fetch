import { SUPABASE_ORIGINAL_PATH_V1 } from "@one-fetch/protocol";
import { restoreSupabaseIngressPath } from "@one-fetch/core";
import type { OneFetchRequestMetaV1 } from "../_shared/protocol-types.ts";
import { pathAndQuery } from "./request.ts";

export interface PathBindingFailure {
  code: "unsupported_option" | "invalid_metadata";
  message: string;
}

export function inspectPathBinding(
  request: Request,
  metadata: OneFetchRequestMetaV1,
): { ok: true; path: string } | { ok: false; error: PathBindingFailure } {
  const original = metadata.fetchOptions.adapter?.[SUPABASE_ORIGINAL_PATH_V1];
  if (original === undefined)
    return {
      ok: false,
      error: {
        code: "unsupported_option",
        message:
          "Supabase requires negotiated supabaseOriginalPathV1 support; update the client and refresh capabilities",
      },
    };
  try {
    return {
      ok: true,
      path: restoreSupabaseIngressPath(original, pathAndQuery(request)),
    };
  } catch {
    return {
      ok: false,
      error: {
        code: "invalid_metadata",
        message:
          "Original path binding is invalid or differs from the Gateway URL beyond supported ingress normalization",
      },
    };
  }
}
