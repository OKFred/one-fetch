import assert from "node:assert/strict";
import test from "node:test";
import { ownedRpcNames, serializeRpcCatalog } from "./supabase-rpc-backup.mjs";
import { rpcFixture } from "./rpc-backup-fixtures.mjs";

test("owned RPCs restore definitions, owner and service-only permissions atomically", () => {
  const result = serializeRpcCatalog(JSON.stringify({ rows: [rpcFixture()] }), [
    "of_example",
  ]);
  assert.equal(result.count, 1);
  assert.match(
    result.source,
    /BEGIN;[\s\S]+CREATE OR REPLACE FUNCTION public.of_example/u,
  );
  assert.match(
    result.source,
    /REVOKE ALL ON FUNCTION public.of_example\(p_value text\) FROM PUBLIC, anon, authenticated, service_role;/u,
  );
  assert.match(
    result.source,
    /GRANT EXECUTE ON FUNCTION public.of_example\(p_value text\) TO service_role;/u,
  );
  assert.match(result.source, /COMMIT;\n$/u);
});

test("catalogs reject missing, extra and duplicate owned identities", () => {
  for (const rows of [
    [],
    [rpcFixture("of_other")],
    [rpcFixture(), rpcFixture()],
  ])
    assert.throws(() =>
      serializeRpcCatalog(JSON.stringify({ rows }), ["of_example"]),
    );
});

test("unsafe ACLs, owner, definitions and unknown fields fail without echoing source", () => {
  for (const patch of [
    { owner: "other" },
    { security_definer: false },
    { extra: true },
    { arguments: "p text); drop schema unrelated; --" },
    {
      definition: "CREATE OR REPLACE FUNCTION public.other() -- secret-canary",
    },
    { grants: [] },
    { grants: [{ grantee: "PUBLIC", privilege: "EXECUTE", grantable: false }] },
    {
      grants: [
        { grantee: "postgres", privilege: "EXECUTE", grantable: true },
        { grantee: "service_role", privilege: "EXECUTE", grantable: true },
      ],
    },
  ]) {
    assert.throws(
      () =>
        serializeRpcCatalog(
          JSON.stringify({ rows: [rpcFixture("of_example", patch)] }),
          ["of_example"],
        ),
      (error) => !error.message.includes("secret-canary"),
    );
  }
});

test("only first installation explicitly permits an empty RPC catalog", () => {
  assert.equal(
    serializeRpcCatalog('{"rows":[]}', ["of_example"], true).count,
    0,
  );
  assert.throws(() => serializeRpcCatalog('{"rows":[]}', ["of_example"]));
  for (const source of [
    "null",
    "{}",
    "broken",
    " ".repeat(2 * 1024 * 1024 + 1),
  ])
    assert.throws(() => serializeRpcCatalog(source, ["of_example"], true));
});

test("immutable source inventory includes auth, quota, reports and deployment RPCs", async () => {
  const names = await ownedRpcNames("none");
  for (const name of [
    "of_get_admin_for_login",
    "of_issue_session",
    "of_get_active_config",
    "of_acquire_execution",
    "of_get_execution_report",
    "of_acquire_deployment_lease",
  ])
    assert.ok(names.includes(name));
  assert.equal(names.length, new Set(names).size);
  await assert.rejects(ownedRpcNames("not-a-build"));
});
