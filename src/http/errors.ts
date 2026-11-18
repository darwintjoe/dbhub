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

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof ApiError) {
    res.status(err.status).json(errorEnvelope(err.code, err.message, err.details));
    return;
  }
  const message = err instanceof Error ? err.message : "Internal error";
  res.status(500).json(errorEnvelope("SYS-500", "Internal server error.", { message }));
}
