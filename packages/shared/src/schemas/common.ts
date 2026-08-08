import { z } from 'zod';

/**
 * Identifiers are prefixed, sortable strings (e.g. `srv_01J...`) rather than bare UUIDs,
 * so a value pasted into a bug report says what it points at.
 */
export const idSchema = z
  .string()
  .min(3)
  .max(64)
  .regex(/^[a-z]+_[A-Za-z0-9]+$/, 'Must be a prefixed identifier such as srv_abc123');

export const isoDateSchema = z.string().datetime({ offset: true });

export const paginationQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  perPage: z.coerce.number().int().min(1).max(100).default(25),
});
export type PaginationQuery = z.infer<typeof paginationQuerySchema>;

export const sortOrderSchema = z.enum(['asc', 'desc']).default('desc');

export function paginatedSchema<T extends z.ZodTypeAny>(item: T) {
  return z.object({
    data: z.array(item),
    meta: z.object({
      page: z.number().int(),
      perPage: z.number().int(),
      total: z.number().int(),
      totalPages: z.number().int(),
    }),
  });
}

export interface Paginated<T> {
  data: T[];
  meta: { page: number; perPage: number; total: number; totalPages: number };
}

/** Ports are user-supplied often enough to deserve a named schema. */
export const portSchema = z.number().int().min(1).max(65535);

/** Docker-safe environment variable key. */
export const envKeySchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Z][A-Z0-9_]*$/, 'Use SCREAMING_SNAKE_CASE');

export const okSchema = z.object({ ok: z.literal(true) });

/**
 * Build the PATCH counterpart of a create schema, where an omitted key means "leave this
 * alone".
 *
 * `.partial()` is the obvious tool and the wrong one: it yields
 * `ZodOptional<ZodDefault<T>>`, and Zod still applies the inner default when the key is
 * absent. A PATCH carrying only `{ memoryTotalMb }` would parse into every other field at
 * its *create-time* default and the route would faithfully write them — silently
 * repointing a node's driver and public host, so every server address on it goes wrong.
 * Stripping the default first is what makes absence mean absence.
 */
export function patchShape<Shape extends z.ZodRawShape>(
  schema: z.ZodObject<Shape>,
): { [K in keyof Shape]: z.ZodOptional<Shape[K]> } {
  const entries = Object.entries(schema.shape).map(([key, field]) => {
    const undefaulted = field instanceof z.ZodDefault ? field.def.innerType : field;
    return [key, (undefaulted as z.ZodTypeAny).optional()];
  });
  return Object.fromEntries(entries) as { [K in keyof Shape]: z.ZodOptional<Shape[K]> };
}
