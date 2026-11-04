/**
 * Shared HTTP helpers for every component in the Login API server.
 * Owned jointly by the passkeys and OIDC teams; changes need both to review.
 */
import type { Context } from 'hono';

/** An error safe to show the client: a stable code plus optional extra fields. Never put request data in it. */
export class ApiError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 429,
    readonly code: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(code);
  }
}

/**
 * Read a JSON body. Requiring application/json also blocks simple cross-site
 * form posts, which is our CSRF protection for state-changing requests.
 */
export async function readJson<T>(c: Context): Promise<T> {
  if (!c.req.header('content-type')?.startsWith('application/json')) {
    throw new ApiError(400, 'expected-json');
  }
  try {
    return (await c.req.json()) as T;
  } catch {
    throw new ApiError(400, 'invalid-json');
  }
}
