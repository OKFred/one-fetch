import {
  CreatedExecutionTokenV1Schema,
  ExecutionTokenListV1Schema,
  ExecutionTokenRecordV1Schema,
  ExecutionTokenRevokeResponseV1Schema,
  type ExecutionTokenRecordV1,
} from "@one-fetch/protocol";

import { executionTokenSchema, readBoundedJson } from "./control-schemas";
import {
  authStub,
  controlError,
  isIdentifier,
  type ControlApp,
} from "./control-support";

export function registerTokenRoutes(app: ControlApp): void {
  app.get("/api/v1/tokens/execution", async (context) => {
    const records = await authStub(context.env).listExecutionTokens(
      context.get("principal").adminId,
    );
    return context.json(
      ExecutionTokenListV1Schema.parse({
        schemaVersion: 1,
        tokens: records.map(publicExecutionTokenRecord),
      }),
    );
  });

  app.post("/api/v1/tokens/execution", async (context) => {
    const input = executionTokenSchema.parse(
      await readBoundedJson(context.req.raw),
    );
    const created = await authStub(context.env).createExecutionToken({
      name: input.name,
      scope: input.scope,
      quota: {
        requestsPerMinute: input.quota.requestsPerMinute,
        burstPerSecond: input.quota.burst,
        concurrentHttp: input.quota.concurrentHttp,
        concurrentTunnels: input.quota.concurrentTunnels,
        bytesPerDay: input.quota.bytesPerDay,
      },
      adminId: context.get("principal").adminId,
      ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
    });
    return context.json(
      CreatedExecutionTokenV1Schema.parse({
        schemaVersion: 1,
        credential: {
          schemaVersion: 1,
          id: created.id,
          name: created.name,
          scope: created.scope,
          quota: publicQuota(created.quota),
          createdAt: created.createdAt,
          ...(created.expiresAt === undefined
            ? {}
            : { expiresAt: created.expiresAt }),
        },
        token: created.token,
      }),
      201,
    );
  });

  app.delete("/api/v1/tokens/execution/:id", async (context) => {
    const id = context.req.param("id");
    if (!isIdentifier(id))
      return controlError(
        404,
        "not_found",
        "The execution token was not found",
      );
    const revokedAt = await authStub(context.env).revokeExecutionToken(
      context.get("principal").adminId,
      id,
    );
    return revokedAt
      ? context.json(
          ExecutionTokenRevokeResponseV1Schema.parse({
            schemaVersion: 1,
            id,
            revokedAt,
          }),
        )
      : controlError(404, "not_found", "The execution token was not found");
  });
}

function publicExecutionTokenRecord(record: {
  id: string;
  name: string;
  scope: unknown;
  quota: {
    requestsPerMinute: number;
    burstPerSecond: number;
    concurrentHttp: number;
    concurrentTunnels: number;
    bytesPerDay: number;
  };
  createdAt: string;
  expiresAt?: string;
  revokedAt?: string;
}): ExecutionTokenRecordV1 {
  return ExecutionTokenRecordV1Schema.parse({
    schemaVersion: 1,
    id: record.id,
    name: record.name,
    scope: record.scope,
    quota: publicQuota(record.quota),
    createdAt: record.createdAt,
    ...(record.expiresAt === undefined ? {} : { expiresAt: record.expiresAt }),
    ...(record.revokedAt === undefined ? {} : { revokedAt: record.revokedAt }),
  });
}

function publicQuota(quota: {
  requestsPerMinute: number;
  burstPerSecond: number;
  concurrentHttp: number;
  concurrentTunnels: number;
  bytesPerDay: number;
}) {
  return {
    requestsPerMinute: quota.requestsPerMinute,
    burst: quota.burstPerSecond,
    concurrentHttp: quota.concurrentHttp,
    concurrentTunnels: quota.concurrentTunnels,
    bytesPerDay: quota.bytesPerDay,
  };
}
