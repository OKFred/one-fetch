import { exports as workerExports } from "cloudflare:workers";
import { env, SELF } from "cloudflare:test";
import { ExecutionReportV1Schema } from "@one-fetch/protocol";
import { describe, expect, it } from "vitest";

import { createCredential, expectControlError } from "./control-fixtures";

describe("Cloudflare terminal execution recording", () => {
  it("returns a report only to its owning execution token", async () => {
    const { pair, credential } = await createCredential("report-token");
    const reportId = crypto.randomUUID();
    await workerExports.ControlService.releaseExecutionJson(
      JSON.stringify({
        tokenId: credential.credential.id,
        requestId: "report-request-1",
        reportId,
        outcome: "target",
        status: 204,
        requestBytes: 0,
        responseBytes: 0,
        durationMs: 12,
        timing: {
          phases: [
            {
              name: "total",
              state: "measured",
              source: "gateway",
              durationMs: 12,
            },
          ],
          serverTiming: [],
        },
        bodyComplete: true,
      }),
    );
    const allowed = await SELF.fetch(
      `https://control.example/api/v1/reports/${reportId}`,
      { headers: { Authorization: `Bearer ${credential.token}` } },
    );
    expect(ExecutionReportV1Schema.parse(await allowed.json())).toMatchObject({
      outcome: "completed",
      source: "target",
      status: 204,
    });

    await workerExports.ControlService.releaseExecutionJson(
      JSON.stringify({
        tokenId: credential.credential.id,
        requestId: "report-request-1",
        reportId: crypto.randomUUID(),
        outcome: "cancelled",
        requestBytes: 0,
        responseBytes: 0,
        durationMs: 20,
        timing: {
          phases: [
            {
              name: "total",
              state: "measured",
              source: "gateway",
              durationMs: 20,
            },
          ],
          serverTiming: [],
        },
        bodyComplete: false,
        errorCode: "cancelled",
      }),
    );
    const terminal = await env.DB.prepare(
      "SELECT report_id, report_json FROM execution_reports WHERE request_id = ? AND token_id = ?",
    )
      .bind("report-request-1", credential.credential.id)
      .first<{ report_id: string; report_json: string }>();
    expect(terminal?.report_id).toBe(reportId);
    expect(
      ExecutionReportV1Schema.parse(JSON.parse(terminal!.report_json)).outcome,
    ).toBe("completed");
    const terminalAudit = await env.DB.prepare(
      `SELECT COUNT(*) AS count FROM audit_events
       WHERE action IN ('execution.target', 'execution.cancelled')`,
    ).first<{ count: number }>();
    expect(terminalAudit?.count).toBe(1);
    await expectControlError(
      await SELF.fetch(`https://control.example/api/v1/reports/${reportId}`, {
        headers: { Authorization: `Bearer ${pair.accessToken}` },
      }),
      404,
      "not_found",
    );
  });

  it("persists a degraded report when the terminal audit write fails", async () => {
    const { credential } = await createCredential("degraded-report-token");
    const reportId = crypto.randomUUID();
    await env.DB.prepare(
      `CREATE TRIGGER reject_terminal_audit
       BEFORE INSERT ON audit_events
       WHEN NEW.action = 'execution.target'
       BEGIN
         SELECT RAISE(ABORT, 'injected terminal audit failure');
       END`,
    ).run();
    try {
      await expect(
        workerExports.ControlService.releaseExecutionJson(
          JSON.stringify({
            tokenId: credential.credential.id,
            requestId: "degraded-report-request",
            reportId,
            outcome: "target",
            requestBytes: 0,
            responseBytes: 2,
            status: 200,
            durationMs: 5,
            timing: { phases: [], serverTiming: [] },
            bodyComplete: true,
          }),
        ),
      ).resolves.toBe("degraded");
      const stored = await env.DB.prepare(
        "SELECT report_json, terminal_event_id FROM execution_reports WHERE report_id = ?",
      )
        .bind(reportId)
        .first<{ report_json: string; terminal_event_id: string | null }>();
      expect(stored?.terminal_event_id).toBeNull();
      expect(
        ExecutionReportV1Schema.parse(JSON.parse(stored!.report_json)),
      ).toMatchObject({ auditState: "degraded", outcome: "completed" });
      expect(
        await env.DB.prepare(
          "SELECT audit_degraded FROM instance_state WHERE singleton = 1",
        ).first<{ audit_degraded: number }>(),
      ).toMatchObject({ audit_degraded: 1 });
    } finally {
      await env.DB.prepare(
        "DROP TRIGGER IF EXISTS reject_terminal_audit",
      ).run();
    }
  });
});
