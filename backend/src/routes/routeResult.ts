import type { Response } from 'express';

/**
 * A handler's answer without the Express response, so the same logic can back
 * a cookie route and a /api/cli/v1 route (routes/cliApi.ts).
 */
export interface RouteResult<T = unknown> {
  status: number;
  body: T;
}

export function sendResult(res: Response, result: RouteResult): void {
  res.status(result.status).json(result.body);
}
