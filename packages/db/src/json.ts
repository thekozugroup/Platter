import type { z } from 'zod';

/**
 * Helpers for the JSON columns.
 *
 * Drizzle's `{ mode: 'json' }` gives you `unknown` on read, which is honest — the column really
 * could contain anything, including data written by an older version of Platter. These helpers
 * make the validation step explicit and, crucially, non-fatal: a settings blob that fails to
 * parse should degrade to defaults and log, not take down the dashboard.
 *
 * The one place that must be strict is anything driving a container's configuration. Those call
 * sites use `parseJsonStrict`.
 */

/** Parse a JSON column, falling back to a default when the stored value no longer matches. */
export function parseJson<S extends z.ZodType>(
  schema: S,
  value: unknown,
  fallback: z.infer<S>,
  onError?: (issues: string) => void
): z.infer<S> {
  const decoded = decode(value);
  const result = schema.safeParse(decoded);
  if (result.success) {
    return result.data;
  }
  onError?.(result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  return fallback;
}

/** Parse a JSON column, throwing when it does not match. */
export function parseJsonStrict<S extends z.ZodType>(schema: S, value: unknown): z.infer<S> {
  return schema.parse(decode(value));
}

/**
 * better-sqlite3 hands back a string for TEXT columns; drizzle's json mode decodes it for us,
 * but the same helpers are used against raw rows from `$sqlite` and from Zod-validated request
 * bodies. Accepting both shapes here avoids a `typeof` check at every call site.
 */
function decode(value: unknown): unknown {
  if (typeof value !== 'string') {
    return value;
  }
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/** Current epoch milliseconds — the unit every timestamp column uses. */
export const nowMs = (): number => Date.now();
