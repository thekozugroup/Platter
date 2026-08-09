import { Readable } from 'node:stream';
import type { Prisma } from '@prisma/client';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { z } from 'zod';
import {
  auditEntrySchema,
  listAuditQuerySchema,
  paginatedSchema,
  roleAtLeast,
  type UserRole,
} from '@platter/shared';
import { prisma } from '../db.js';
import { unauthenticated } from '../lib/errors.js';
import type { AuthContext } from '../plugins/auth.js';
import { toAuditEntries, toAuditEntry } from '../services/audit.js';

/**
 * The audit feed. Admins (and owners, which outrank admin) see every entry; a member sees
 * only entries whose target is a server they own — not one they merely have subuser access
 * to, and not their own `auth.*`/`user.*` history, which this endpoint is not for.
 *
 * Every filter below maps onto one of `AuditLog`'s four single-column indexes
 * (`createdAt`, `actorId`, `targetId`, `action`), so nothing here forces a table scan —
 * including the member restriction, which filters on the same `targetId` index everyone
 * else's `targetId` filter would use.
 *
 * That indexing is also the reason a member does *not* see `backup.*` or `schedule.*` rows
 * for their own servers: those rows target the backup or the schedule, and name the server
 * only inside `metadata`, which is a JSON text column with no index. Widening the member
 * view to include them would mean either a scan of the whole log or a second denormalised
 * column. This is a known and deliberate narrowness, not an oversight — a member who needs
 * that history has it on the server's own backups and schedules pages.
 */

function requireAuth(request: FastifyRequest): AuthContext {
  if (!request.auth) throw unauthenticated();
  return request.auth;
}

async function scopeCondition(viewer: {
  id: string;
  role: UserRole;
}): Promise<Prisma.AuditLogWhereInput[]> {
  if (roleAtLeast(viewer.role, 'admin')) return [];

  const owned = await prisma.server.findMany({
    where: { ownerId: viewer.id },
    select: { id: true },
  });
  return [{ targetType: 'server' }, { targetId: { in: owned.map((server) => server.id) } }];
}

type AuditFilters = Omit<z.infer<typeof listAuditQuerySchema>, 'page' | 'perPage'>;

function filterConditions(query: AuditFilters): Prisma.AuditLogWhereInput[] {
  const conditions: Prisma.AuditLogWhereInput[] = [];
  if (query.action !== undefined) conditions.push({ action: query.action });
  if (query.actorId !== undefined) conditions.push({ actorId: query.actorId });
  if (query.targetId !== undefined) conditions.push({ targetId: query.targetId });
  if (query.since !== undefined) conditions.push({ createdAt: { gte: new Date(query.since) } });
  if (query.until !== undefined) conditions.push({ createdAt: { lte: new Date(query.until) } });
  return conditions;
}

const EXPORT_CHUNK_SIZE = 500;

/**
 * Cursor pagination on the id (a ULID — lexically sortable, so `orderBy: id desc` is
 * chronological) rather than `OFFSET`, so an export of a large log does not get slower
 * page by page, and everything is read as one bounded chunk at a time regardless of how
 * many rows match.
 */
async function* iterateAudit(where: Prisma.AuditLogWhereInput): AsyncGenerator<string> {
  let cursor: string | undefined;
  for (;;) {
    const rows = await prisma.auditLog.findMany({
      where: cursor ? { AND: [where, { id: { lt: cursor } }] } : where,
      orderBy: { id: 'desc' },
      take: EXPORT_CHUNK_SIZE,
    });
    if (rows.length === 0) return;
    for (const row of rows) {
      const entry = toAuditEntry(row);
      if (entry) yield `${JSON.stringify(entry)}\n`;
    }
    const last = rows[rows.length - 1];
    if (rows.length < EXPORT_CHUNK_SIZE || !last) return;
    cursor = last.id;
  }
}

const exportQuerySchema = listAuditQuerySchema.omit({ page: true, perPage: true });

const auditRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.get(
    '/',
    {
      preHandler: app.requireScope('audit.read'),
      schema: {
        tags: ['audit'],
        summary: 'List audit entries',
        querystring: listAuditQuerySchema,
        response: { 200: paginatedSchema(auditEntrySchema) },
      },
    },
    async (request) => {
      const { user } = requireAuth(request);
      const { page, perPage, ...filters } = request.query;
      const conditions = [...(await scopeCondition(user)), ...filterConditions(filters)];
      const where: Prisma.AuditLogWhereInput = conditions.length > 0 ? { AND: conditions } : {};

      const [total, rows] = await Promise.all([
        prisma.auditLog.count({ where }),
        prisma.auditLog.findMany({
          where,
          orderBy: { id: 'desc' },
          skip: (page - 1) * perPage,
          take: perPage,
        }),
      ]);

      return {
        data: toAuditEntries(rows),
        meta: { page, perPage, total, totalPages: Math.max(1, Math.ceil(total / perPage)) },
      };
    },
  );

  app.get(
    '/export',
    {
      preHandler: app.requireScope('audit.read'),
      schema: {
        tags: ['audit'],
        summary: 'Export audit entries as newline-delimited JSON',
        description: 'Streamed, not buffered — safe to call against a log with millions of rows.',
        querystring: exportQuerySchema,
      },
    },
    async (request, reply) => {
      const { user } = requireAuth(request);
      const conditions = [...(await scopeCondition(user)), ...filterConditions(request.query)];
      const where: Prisma.AuditLogWhereInput = conditions.length > 0 ? { AND: conditions } : {};

      reply.header('content-type', 'application/x-ndjson; charset=utf-8');
      reply.header('content-disposition', 'attachment; filename="platter-audit-log.ndjson"');
      return reply.send(Readable.from(iterateAudit(where)));
    },
  );
};

export default auditRoutes;
