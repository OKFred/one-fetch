import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseOptions } from "./deploy-release.mjs";
import {
  applyHostedDeployment,
  assertFirstInstallBackupIsEmpty,
  deploymentRpc,
} from "./supabase-apply.mjs";

test("hosted apply requires file-based credentials", () => {
  const base = [
    "--project-ref",
    "abcdefghijklmnopqrst",
    "--env-file",
    "safe.env",
    "--expected-current-build",
    "none",
  ];
  assert.throws(() => parseOptions([...base, "--apply"]));
  assert.throws(() => parseOptions([...base, "--resume"]));
  assert.equal(
    parseOptions([
      ...base,
      "--apply",
      "--service-role-key-file",
      "service.key",
      "--db-password-file",
      "database.key",
    ]).apply,
    true,
  );
});

test("first install refuses a pre-existing one-fetch schema", () => {
  assert.doesNotThrow(() =>
    assertFirstInstallBackupIsEmpty("create schema public;"),
  );
  assert.throws(() =>
    assertFirstInstallBackupIsEmpty("CREATE SCHEMA one_fetch;"),
  );
  assert.throws(() =>
    assertFirstInstallBackupIsEmpty("copy one_fetch.audit_events from stdin;"),
  );
});

test("deployment RPC keeps the service key out of the URL and body", async () => {
  const calls = [];
  const result = await deploymentRpc(
    {
      fetch: (url, init) => {
        calls.push({ url, init });
        return Promise.resolve(globalThis.Response.json({ acquired: true }));
      },
      projectRef: "abcdefghijklmnopqrst",
      serviceRoleKey: "service-role-secret-value-that-is-private",
    },
    "of_acquire_deployment_lease",
    { p_expected_build: "none" },
  );
  assert.equal(result.acquired, true);
  assert.doesNotMatch(calls[0].url, /service-role-secret/u);
  assert.doesNotMatch(calls[0].init.body, /service-role-secret/u);
  assert.equal(
    calls[0].init.headers.apikey,
    "service-role-secret-value-that-is-private",
  );
});

test("fresh apply backs up, leases, deploys both functions, and verifies", async () => {
  const root = await mkdtemp(join(tmpdir(), "one-fetch-supabase-apply-"));
  try {
    const serviceKeyPath = join(root, "service.key");
    const passwordPath = join(root, "database.key");
    const envPath = join(root, "functions.env");
    await Promise.all([
      writeFile(serviceKeyPath, "s".repeat(40)),
      writeFile(passwordPath, "p".repeat(32)),
      writeFile(envPath, "SAFE=fixture"),
    ]);
    const desiredBuildId = "0.1.0+supabase.g111111111111";
    const commands = [];
    const inventory = new Map();
    const recorder = {
      path: join(root, "state.json"),
      state: { runId: randomUUID() },
      async update(patch) {
        this.state = { ...this.state, ...patch };
        return this.state;
      },
    };
    const runPnpm = (arguments_, options = {}) => {
      commands.push({ arguments_, options });
      if (arguments_.includes("dump")) {
        const output = arguments_[arguments_.indexOf("--file") + 1];
        return writeFile(output, "create schema public;\n");
      }
      if (arguments_.includes("deploy")) {
        const slug = arguments_[arguments_.indexOf("deploy") + 1];
        inventory.set(slug, { slug, version: 1 });
      }
      return undefined;
    };
    const request = (url) => {
      const name = new globalThis.URL(url).pathname.split("/").at(-1);
      if (name === "of_acquire_deployment_lease")
        return Promise.resolve(globalThis.Response.json({ acquired: true }));
      if (name === "of_renew_deployment_lease")
        return Promise.resolve(globalThis.Response.json({ renewed: true }));
      if (name === "of_complete_deployment")
        return Promise.resolve(globalThis.Response.json({ completed: true }));
      throw new Error(`Unexpected fixture URL ${url}`);
    };
    const state = await applyHostedDeployment({
      options: {
        apply: true,
        expectedCurrentBuild: "none",
        projectRef: "abcdefghijklmnopqrst",
        envFile: envPath,
        serviceRoleKeyFile: serviceKeyPath,
        dbPasswordFile: passwordPath,
      },
      environment: new Map(),
      desiredBuildId,
      recorder,
      beforeFunctions: new Map(),
      databaseLink: { workdir: join(root, "database-link") },
      databasePassword: "p".repeat(32),
      runPnpm,
      functionList: () => new Map(inventory),
      inspectCurrent: () => Promise.resolve({ buildId: desiredBuildId }),
      fetch: request,
    });
    assert.equal(state.status, "verified");
    assert.deepEqual(state.deployedFunctions, [
      "one-fetch-control",
      "one-fetch-gateway",
    ]);
    assert.equal(state.gatewayPaused, false);
    const dump = commands.find(({ arguments_ }) => arguments_.includes("dump"));
    assert.equal(dump.options.environment.SUPABASE_DB_PASSWORD, "p".repeat(32));
    assert(dump.arguments_.includes("--linked"));
    assert.equal(dump.arguments_.includes("--project-ref"), false);
    assert.equal(
      commands.some(({ arguments_ }) => arguments_.includes("secrets")),
      true,
    );
    for (const { arguments_ } of commands.filter(({ arguments_ }) =>
      ["dump", "push", "secrets", "deploy"].some((command) =>
        arguments_.includes(command),
      ),
    )) {
      assert(arguments_.includes("--workdir"));
    }
    const commandText = JSON.stringify(
      commands.map(({ arguments_, options }) => ({
        arguments_,
        label: options.label,
      })),
    );
    assert.doesNotMatch(commandText, /s{32}/u);
    assert.doesNotMatch(commandText, /p{32}/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("failed update restores prior Functions and keeps Gateway paused", async () => {
  const root = await mkdtemp(join(tmpdir(), "one-fetch-supabase-update-"));
  try {
    const serviceKeyPath = join(root, "service.key");
    const passwordPath = join(root, "database.key");
    const adminTokenPath = join(root, "admin.token");
    const envPath = join(root, "functions.env");
    await Promise.all([
      writeFile(serviceKeyPath, "s".repeat(40)),
      writeFile(passwordPath, "p".repeat(32)),
      writeFile(adminTokenPath, "a".repeat(32)),
      writeFile(envPath, "SAFE=fixture"),
    ]);
    const currentBuild = "0.1.0+supabase.g000000000000";
    const desiredBuild = "0.1.0+supabase.g111111111111";
    const events = [];
    const inventory = new Map([
      ["one-fetch-control", { slug: "one-fetch-control", version: 1 }],
      ["one-fetch-gateway", { slug: "one-fetch-gateway", version: 1 }],
    ]);
    const recorder = {
      path: join(root, "state.json"),
      state: { runId: randomUUID() },
      async update(patch) {
        this.state = { ...this.state, ...patch };
        return this.state;
      },
    };
    let gatewayFailed = false;
    const runPnpm = (arguments_, options = {}) => {
      events.push(`cli:${options.label}`);
      if (arguments_.includes("download")) {
        const slug = arguments_[arguments_.indexOf("download") + 1];
        const workdir = arguments_[arguments_.indexOf("--workdir") + 1];
        const directory = join(workdir, "supabase", "functions", slug);
        mkdirSync(directory, { recursive: true });
        writeFileSync(join(directory, "index.js"), `// prior ${slug}\n`);
      }
      if (arguments_.includes("dump")) {
        const output = arguments_[arguments_.indexOf("--file") + 1];
        writeFileSync(output, "create schema one_fetch;\n");
      }
      if (arguments_.includes("deploy")) {
        const slug = arguments_[arguments_.indexOf("deploy") + 1];
        const workdir = arguments_[arguments_.indexOf("--workdir") + 1];
        const isRecovery = workdir?.includes("recovery-") === true;
        if (slug === "one-fetch-gateway" && !isRecovery && !gatewayFailed) {
          gatewayFailed = true;
          throw new Error("fixture gateway failure");
        }
        if (!isRecovery) {
          const prior = inventory.get(slug);
          inventory.set(slug, { ...prior, version: prior.version + 1 });
        }
      }
    };
    const request = (url, init) => {
      const parsed = new globalThis.URL(url);
      if (parsed.pathname.endsWith("/api/v1/config")) {
        events.push("http:config");
        assert.match(init.headers.Authorization, /^Bearer a+$/u);
        return Promise.resolve(
          globalThis.Response.json({
            version: "config-1",
            gatewayPaused: false,
          }),
        );
      }
      if (parsed.pathname.endsWith("/api/v1/config/gateway-paused")) {
        events.push("http:pause");
        assert.match(init.headers.Authorization, /^Bearer a+$/u);
        assert.equal(init.headers["If-Match"], '"config-1"');
        return Promise.resolve(
          globalThis.Response.json({ gatewayPaused: true }),
        );
      }
      const name = parsed.pathname.split("/").at(-1);
      events.push(`rpc:${name}`);
      if (name === "of_acquire_deployment_lease")
        return Promise.resolve(globalThis.Response.json({ acquired: true }));
      if (name === "of_renew_deployment_lease")
        return Promise.resolve(globalThis.Response.json({ renewed: true }));
      if (name === "of_fail_deployment")
        return Promise.resolve(globalThis.Response.json({ failed: true }));
      throw new Error(`Unexpected fixture URL ${url}`);
    };
    await assert.rejects(
      applyHostedDeployment({
        options: {
          apply: true,
          expectedCurrentBuild: currentBuild,
          projectRef: "abcdefghijklmnopqrst",
          envFile: envPath,
          serviceRoleKeyFile: serviceKeyPath,
          dbPasswordFile: passwordPath,
          adminTokenFile: adminTokenPath,
        },
        environment: new Map([
          [
            "ONE_FETCH_CONTROL_BASE_URL",
            "https://abcdefghijklmnopqrst.supabase.co/functions/v1/one-fetch-control",
          ],
        ]),
        desiredBuildId: desiredBuild,
        recorder,
        beforeFunctions: new Map(inventory),
        databaseLink: { workdir: join(root, "database-link") },
        databasePassword: "p".repeat(32),
        runPnpm,
        functionList: () => new Map(inventory),
        inspectCurrent: () => Promise.resolve({ buildId: desiredBuild }),
        fetch: request,
      }),
      /fixture gateway failure/u,
    );
    assert.equal(recorder.state.status, "failed");
    assert.equal(recorder.state.gatewayPaused, true);
    assert.equal(recorder.state.rollback.functionRollbackSucceeded, true);
    assert.equal(
      events.filter((event) => event.startsWith("cli:restore prior")).length,
      2,
    );
    const recoveryConfig = await readFile(
      join(recorder.state.recovery.root, "supabase", "config.toml"),
      "utf8",
    );
    assert.match(
      recoveryConfig,
      /entrypoint = "\.\/functions\/one-fetch-control\/index\.js"/u,
    );
    assert.match(
      recoveryConfig,
      /entrypoint = "\.\/functions\/one-fetch-gateway\/index\.js"/u,
    );
    assert(
      events.indexOf("rpc:of_acquire_deployment_lease") <
        events.indexOf("cli:apply forward migrations"),
    );
    assert(events.includes("rpc:of_fail_deployment"));
    assert.equal(events.includes("rpc:of_complete_deployment"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
