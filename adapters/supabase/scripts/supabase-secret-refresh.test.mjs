import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import {
  assertSecretRefreshTransition,
  parseFunctionList,
} from "./deploy-support.mjs";

function record(slug, version, digest, id) {
  return {
    id,
    slug,
    name: slug,
    status: "ACTIVE",
    version,
    created_at: 1_725_408_000_000,
    updated_at: 1_725_408_001_000 + version,
    verify_jwt: false,
    entrypoint_path: `file:///tmp/${slug}_${version}/source/supabase/functions/${slug}/.one-fetch-bundle/index.js`,
    ezbr_sha256: digest.repeat(64),
  };
}

test("secret refresh permits only provider deployment metadata changes", () => {
  const controlId = randomUUID();
  const gatewayId = randomUUID();
  const beforeRecords = [
    record("one-fetch-control", 4, "a", controlId),
    record("one-fetch-gateway", 7, "b", gatewayId),
  ];
  const afterRecords = [
    record("one-fetch-control", 5, "a", controlId),
    record("one-fetch-gateway", 8, "b", gatewayId),
  ];
  const before = parseFunctionList(JSON.stringify(beforeRecords));
  const after = parseFunctionList(JSON.stringify(afterRecords));

  assert.doesNotThrow(() => assertSecretRefreshTransition(before, after));
  afterRecords[1].ezbr_sha256 = "c".repeat(64);
  assert.throws(
    () =>
      assertSecretRefreshTransition(
        before,
        parseFunctionList(JSON.stringify(afterRecords)),
      ),
    /code changed/u,
  );
});
