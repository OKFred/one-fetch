import {
  SUPABASE_ORIGINAL_PATH_V1,
  type FetchOptionCapabilityV1,
  type FetchOptionsV1,
} from "@one-fetch/protocol";
import { assertOriginalPath } from "@one-fetch/core";

export function bindGatewayPath(
  target: URL,
  options: FetchOptionsV1,
  capabilities: readonly FetchOptionCapabilityV1[] | undefined,
): FetchOptionsV1 {
  const option = `adapter.${SUPABASE_ORIGINAL_PATH_V1}`;
  const declarations =
    capabilities?.filter((entry) => entry.option === option) ?? [];
  const supplied = options.adapter?.[SUPABASE_ORIGINAL_PATH_V1];
  const supabase =
    capabilities?.some(
      (entry) => entry.option === "adapter.supabaseAcceptMutations",
    ) === true;
  if (declarations.length === 0 && supplied === undefined && !supabase)
    return options;
  if (declarations.length !== 1 || declarations[0]?.fidelity !== "exact")
    throw new TypeError(
      "Gateway must advertise exact supabaseOriginalPathV1 support; refresh capabilities or upgrade the service",
    );
  const original = `${target.pathname}${target.search}`;
  assertOriginalPath(original);
  if (supplied !== undefined && supplied !== original)
    throw new TypeError("Original path binding conflicts with the target URL");
  return {
    ...options,
    adapter: { ...options.adapter, [SUPABASE_ORIGINAL_PATH_V1]: original },
  };
}
