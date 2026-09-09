import { ZodError, type ZodType } from "zod";

export class RequestValidationError extends Error {
  constructor(readonly issueCount: number) {
    super(`Request validation failed (${issueCount} issue(s))`);
    this.name = "RequestValidationError";
  }
}

export function parseRequest<T>(schema: ZodType<T>, value: unknown): T {
  try {
    return schema.parse(value);
  } catch (error) {
    if (error instanceof ZodError) {
      throw new RequestValidationError(error.issues.length);
    }
    throw error;
  }
}
