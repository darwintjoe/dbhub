import type { Request, Response, NextFunction } from "express";

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

export function errorEnvelope(code: string, message: string, details?: unknown) {
  return { error: { code, message, details: details ?? {} } };
}

interface ErrorLogger {
  error(obj: Record<string, unknown>, message: string): void;
}

interface MappedError {
  status: number;
  code: string;
  message: string;
  details?: unknown;
}

function mapError(err: unknown): MappedError {
  if (err instanceof ApiError) {
    return { status: err.status, code: err.code, message: err.message, details: err.details };
  }
  const type = (err as { type?: string } | null)?.type;
  if (type === "entity.parse.failed") {
    return { status: 400, code: "BUNDLE-001", message: "Malformed JSON body." };
  }
  if (type === "entity.too.large") {
    return { status: 413, code: "BUNDLE-007", message: "Bundle too large." };
  }
  if (type === "charset.unsupported" || type === "encoding.unsupported") {
    return { status: 415, code: "BUNDLE-001", message: "Unsupported request encoding." };
  }
  return { status: 500, code: "SYS-500", message: "Internal server error.", details: {} };
}

export function createErrorHandler(logger?: ErrorLogger) {
  return (err: unknown, req: Request, res: Response, _next: NextFunction): void => {
    const mapped = mapError(err);
    if (mapped.status >= 500) {
      logger?.error(
        { err, requestId: (req as Request & { requestId?: string }).requestId },
        "internal error",
      );
    }
    res.status(mapped.status).json(errorEnvelope(mapped.code, mapped.message, mapped.details));
  };
}

export const errorHandler = createErrorHandler();
