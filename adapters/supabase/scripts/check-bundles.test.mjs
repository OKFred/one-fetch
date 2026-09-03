import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import test from "node:test";

import {
  inspectBundle,
  inspectModuleGraph,
  parseMode,
} from "./check-bundles.mjs";

test("bundle mode is explicit", () => {
  assert.equal(parseMode(["--check"]), "check");
  assert.equal(parseMode(["--stage"]), "stage");
  assert.throws(() => parseMode([]), /Usage/u);
  assert.throws(() => parseMode(["--write"]), /Usage/u);
});

test("bundle inspection accepts only self-contained runtime code", () => {
  const source =
    'import crypto from "node:crypto";\nconst handler = { fetch: crypto };\nexport { handler as default };\n';
  const details = inspectBundle(source, "fixture");
  assert.equal(details.bytes, Buffer.byteLength(source));
  assert.match(details.sha256, /^[a-f0-9]{64}$/u);
});

test("bundle inspection rejects unresolved dependencies", () => {
  assert.throws(
    () =>
      inspectBundle(
        'import value from "../../packages/core/dist/index.js";\nconst handler = { fetch: value };\nexport { handler as default };',
        "fixture",
      ),
    /retained external imports/u,
  );
  assert.throws(
    () => inspectBundle("export const value = 1;", "fixture"),
    /default handler/u,
  );
});

test("module graph permits only the generated file and runtime built-ins", () => {
  const rootUrl = "file:///tmp/index.js";
  inspectModuleGraph(
    {
      modules: [{ specifier: rootUrl }, { specifier: "node:crypto" }],
      npmPackages: {},
    },
    rootUrl,
    "fixture",
  );
  assert.throws(
    () =>
      inspectModuleGraph(
        {
          modules: [
            { specifier: rootUrl },
            { specifier: "file:///tmp/shared.js" },
          ],
          npmPackages: {},
        },
        rootUrl,
        "fixture",
      ),
    /not self-contained/u,
  );
  assert.throws(
    () =>
      inspectModuleGraph(
        {
          modules: [{ specifier: rootUrl, error: "module missing" }],
          npmPackages: {},
        },
        rootUrl,
        "fixture",
      ),
    /module missing/u,
  );
});
