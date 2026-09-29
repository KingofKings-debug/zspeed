import type { Request, Response, NextFunction } from "express";

export class AppError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
    public details?: unknown
  ) {
    super(message);
    this.name = "AppError";
  }
}

export function errorHandler(err: Error, _req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof AppError) {
    res.status(err.statusCode).json({
      status: err.statusCode,
      code: err.code,
      message: err.message,
      details: err.details,
    });
    return;
  }

  console.error("Unhandled error:", err);
  res.status(500).json({
    status: 500,
    code: "INTERNAL_ERROR",
    message: "An unexpected error occurred",
  });
}
