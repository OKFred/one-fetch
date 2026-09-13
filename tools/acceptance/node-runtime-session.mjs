import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import {
  OneFetchControlClient,
  OneFetchGatewayClient,
} from "../../packages/client/dist/index.js";
import { verifyAuditEvent } from "../../packages/core/dist/index.js";
import {
  ALL_HTTP_CONFORMANCE_FIXTURES,
  runGatewayConformance,
  createAcceptanceReport,
} from "../../packages/conformance/dist/index.js";

export function assertNoRuntimeSecrets(value, secrets) {
  const text = JSON.stringify(value);
  if (
    secrets.some(
      (secret) =>
        typeof secret === "string" &&
        secret.length > 0 &&
        text.includes(secret),
    )
  )
    throw new Error("Runtime receipt contains a secret canary");
}

// Admin/session credentials stay in this process. No host credential directory is used.
export async function acceptNodeRuntime({
  controlUrl,
  gatewayUrl,
  targetUrl,
  bootstrapToken,
  commit,
  version,
  auditPublicKey,
  secrets,
  onStep = () => {},
  onSuite = () => {},
}) {
  const request = (input, init = {}) =>
    globalThis.fetch(input, {
      ...init,
      signal: init.signal ?? globalThis.AbortSignal.timeout(20_000),
    });
  const control = new OneFetchControlClient({ controlUrl, fetch: request });
  const admin = {
    username: `artifact-${randomUUID().slice(0, 8)}`,
    password: randomBytes(36).toString("base64url"),
  };
  const canaries = [...secrets, bootstrapToken, admin.password];
  onStep("bootstrap");
  const status = await control.getBootstrapStatus();
  assert.equal(status.initialized, false);
  const pair = await control.bootstrap({
    schemaVersion: 1,
    bootstrapSecret: bootstrapToken,
    ...admin,
  });
  canaries.push(pair.accessToken, pair.refreshToken);
  assert.ok(
    (await control.listSessions()).sessions.some(
      (session) => session.id === pair.sessionId,
    ),
  );
  const refreshed = await control.refresh({
    schemaVersion: 1,
    refreshToken: pair.refreshToken,
  });
  canaries.push(refreshed.accessToken, refreshed.refreshToken);
  await control.logout();
  onStep("login");
  const login = await control.login({
    schemaVersion: 1,
    ...admin,
    rememberDevice: false,
  });
  canaries.push(login.accessToken, login.refreshToken);
  onStep("policy");
  let config = await control.getConfiguration();
  assert.equal(config.policy.mode, "allowlist");
  assert.equal(config.policy.rules.length, 0);
  config = await control.updatePolicy(
    {
      schemaVersion: 1,
      policy: {
        schemaVersion: 1,
        mode: "allowlist",
        revision: config.policy.revision,
        rules: [
          {
            id: "artifact-target",
            name: "Synthetic loopback target",
            enabled: true,
            action: "allow",
            match: {
              transports: ["http"],
              schemes: ["http"],
              origins: [
                { operator: "exact", value: targetUrl, caseSensitive: false },
              ],
            },
          },
        ],
      },
    },
    config.version,
  );
  if (config.gatewayPaused)
    await control.setGatewayPaused(
      { schemaVersion: 1, paused: false },
      config.version,
    );
  onStep("execution-token");
  const credential = await control.createExecutionToken({
    schemaVersion: 1,
    name: "artifact-conformance",
    scope: {
      transports: ["http"],
      origins: [targetUrl],
      ports: [Number(new globalThis.URL(targetUrl).port)],
    },
    quota: {
      requestsPerMinute: 300,
      burst: 50,
      concurrentHttp: 4,
      concurrentTunnels: 0,
      bytesPerDay: 1073741824,
    },
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
  });
  canaries.push(credential.token);
  onStep("capabilities");
  const capabilities = await control.getCapabilities();
  assert.equal(capabilities.provider, "node");
  assert.equal(capabilities.buildVersion, version);
  assert.equal(capabilities.transports.http.state, "stable");
  for (const type of ["websocket", "tcp", "tls"])
    assert.equal(capabilities.transports[type].state, "unsupported");
  const gateway = new OneFetchGatewayClient({
    gatewayUrl,
    token: credential.token,
    capabilities: capabilities.fetchOptions,
  });
  onStep("http-suite");
  const suite = await runGatewayConformance(
    gateway,
    targetUrl,
    ALL_HTTP_CONFORMANCE_FIXTURES,
    {
      getExecutionReport: (id) =>
        control.getExecutionReport(id, credential.token),
      maximumIncompleteDurationMs: 10_000,
    },
  );
  const report = await createAcceptanceReport({
    commit,
    capabilities,
    controlUrl,
    gatewayUrl,
    targetUrl,
    suite,
    cleanup: { state: "pending", resources: [] },
  });
  assertNoRuntimeSecrets(report, canaries);
  // Preserve completed HTTP evidence even if subsequent auth/audit checks fail.
  onSuite(report);
  onStep("revocation");
  await control.revokeExecutionToken(credential.credential.id);
  onStep("revoked-request");
  const revoked = await gateway.executeHttp({
    method: "GET",
    targetUrl: targetUrl + "/status/200",
  });
  await revoked.response.arrayBuffer();
  onStep(`revoked-classification-${revoked.classification.source}`);
  assert.equal(revoked.classification.source, "relay");
  onStep(`revoked-error-${revoked.classification.error.code}`);
  assert.equal(revoked.classification.error.code, "unauthorized");
  onStep("audit");
  const events = [];
  let cursor;
  do {
    const page = await control.getAuditPage({
      limit: 100,
      ...(cursor ? { cursor } : {}),
    });
    events.push(...page.events);
    cursor = page.nextCursor;
    assert.ok(events.length < 1000);
  } while (cursor);
  assert.ok(events.length > 10);
  for (const event of events)
    assert.equal(await verifyAuditEvent(event, auditPublicKey), true);
  assertNoRuntimeSecrets(events, canaries);
  assertNoRuntimeSecrets(report, canaries);
  return {
    report,
    authenticationVerified: true,
    revocationVerified: true,
    verifiedAuditEvents: events.length,
  };
}
