import { stableJson } from "./crypto.js";
import type { DatabaseClient } from "./database.js";

const REPORT_RETENTION_MS = 10 * 60 * 1_000;

export interface ExecutionReport {
  bodyComplete: boolean;
  bodySha256?: string;
  finishedAt: string;
  outcome: "completed" | "partial" | "timeout" | "cancelled" | "relay-error";
  requestId: string;
  responseBytes: number;
  timing: {
    downloadMs?: number;
    totalMs: number;
  };
}

export class ExecutionReportStore {
  constructor(private readonly database: DatabaseClient) {}

  async save(report: ExecutionReport, tokenId: string): Promise<void> {
    const now = new Date();
    await this.database.run(
      `INSERT INTO execution_reports(request_id, token_id, outcome, report_json, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(request_id) DO UPDATE SET outcome = excluded.outcome,
         report_json = excluded.report_json, expires_at = excluded.expires_at`,
      [
        report.requestId,
        tokenId,
        report.outcome,
        stableJson(report),
        new Date(now.getTime() + REPORT_RETENTION_MS).toISOString(),
        now.toISOString(),
      ],
    );
  }

  async get(
    requestId: string,
    tokenId?: string,
  ): Promise<ExecutionReport | undefined> {
    const tokenClause = tokenId ? " AND token_id = ?" : "";
    const parameters = tokenId
      ? [requestId, new Date().toISOString(), tokenId]
      : [requestId, new Date().toISOString()];
    const row = await this.database.get<{ report_json: string }>(
      `SELECT report_json FROM execution_reports WHERE request_id = ? AND expires_at > ?${tokenClause}`,
      parameters,
    );
    return row ? (JSON.parse(row.report_json) as ExecutionReport) : undefined;
  }

  async cleanup(): Promise<number> {
    const result = await this.database.run(
      "DELETE FROM execution_reports WHERE expires_at <= ?",
      [new Date().toISOString()],
    );
    return result.changes;
  }
}
