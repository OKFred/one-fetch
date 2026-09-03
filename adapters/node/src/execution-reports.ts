import {
  ExecutionReportV1Schema,
  type ExecutionReportV1,
} from "@one-fetch/protocol";

import { stableJson } from "./crypto.js";
import type { DatabaseClient } from "./database.js";

const REPORT_RETENTION_MS = 10 * 60 * 1_000;

export class ExecutionReportStore {
  constructor(private readonly database: DatabaseClient) {}

  async save(report: ExecutionReportV1, tokenId: string): Promise<void> {
    const validated = ExecutionReportV1Schema.parse(report);
    const now = new Date();
    await this.database.run(
      `INSERT INTO execution_reports(request_id, token_id, outcome, report_json, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(request_id) DO UPDATE SET outcome = excluded.outcome,
         report_json = excluded.report_json, expires_at = excluded.expires_at`,
      [
        validated.reportId,
        tokenId,
        validated.outcome,
        stableJson(validated),
        new Date(now.getTime() + REPORT_RETENTION_MS).toISOString(),
        now.toISOString(),
      ],
    );
  }

  async get(
    requestId: string,
    tokenId?: string,
  ): Promise<ExecutionReportV1 | undefined> {
    const tokenClause = tokenId ? " AND token_id = ?" : "";
    const parameters = tokenId
      ? [requestId, new Date().toISOString(), tokenId]
      : [requestId, new Date().toISOString()];
    const row = await this.database.get<{ report_json: string }>(
      `SELECT report_json FROM execution_reports WHERE request_id = ? AND expires_at > ?${tokenClause}`,
      parameters,
    );
    return row
      ? ExecutionReportV1Schema.parse(JSON.parse(row.report_json))
      : undefined;
  }

  async cleanup(): Promise<number> {
    const result = await this.database.run(
      "DELETE FROM execution_reports WHERE expires_at <= ?",
      [new Date().toISOString()],
    );
    return result.changes;
  }
}
