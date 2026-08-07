import { Readable } from 'node:stream';
import type { Prisma } from '@prisma/client';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { auditEntrySchema, listAuditQuerySchema, paginatedSchema, roleAtLeast, type UserRole } from '@platter/shared';
import { prisma } from '../db.js';
import { unauthenticated } from '../lib/errors.js';
import type { AuthContext } from '../plugins/auth.js';
import { toAuditEntries, toAuditEntry } from '../services/audit.js';

/**
 * The audit feed. Ordered by `id` rather than `createdAt` — the ids are monotonic ULIDs
 * (see `lib/ids.ts`), so sorting on the primary key already gives exact write order without
 * a second index, and stays correct even for two entries written in the same millisecond.
 */

const exportQuerySchema = listAuditQuerySchema.omit({ page: true, perPage: true });

function requireAuth(request: FastifyRequest): AuthContext {
  if (!request.auth) throw unauthenticated();
  return request.auth;
}

/**
 * `null` means "cannot see any audit entry at all" — a member with no servers — which is
 * different from `{}`, an admin's unrestricted scope. Kept apart so the caller can short
 * -circuit rather than run a query with an empty `IN ()` that a naive `{}` would produce.
 */
async function scopeFor(user: { id: string; role: UserRole }): Promise<Prisma.AuditLogWhereInput | null> {
  if (roleAtLeast(user.role, 'admin')) return {};

  const servers = await prisma.server.findMany({
    where: { OR: [{ ownerId: user.id }, { subusers: { some: { userId: user.id } } }] },
    select: { id: true },
  });
  if (servers.length === 0) return null;
  return { targetType: 'server', targetId: { in: servers.map((server) => server.id) } };
}

interface Filterable {
  action?: string;
  actorId?: string;
  targetId?: string;
  since?: string;
  until?: string;
}

/** Every field here is indexed on `AuditLog` (see schema.prisma), so this never table-scans. */
function filtersFrom(query: Filterable): Prisma.AuditLogWhereInput[] {
  const filters: Prisma.AuditLogWhereInput[] = [];
  if (query.action) filters.push({ action: query.action });
  if (query.actorId) filters.push({ actorId: query.actorId });
  if (query.targetId) filters.push({ targetId: query.targetId });
  if (query.since) filters.push({ createdAt: { gte: new Date(query.since) } });
  if (query.until) filters.push({ createdAt: { lte: new Date(query.until) } });
  return filters;
}

const EXPORT_BATCH_SIZE = 500;

const auditRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.get(
    '/',
    {
      preHandler: fastify.authenticate,
      schema: {
        tags: ['audit'],
        summary: 'List audit entries',
        description: 'Admins and owners see everything; a member sees only entries for their own servers.',
        querystring: listAuditQuerySchema,
        response: { 200: paginatedSchema(auditEntrySchema) },
      },
    },
    async (request) => {
      const { user } = requireAuth(request);
      const query = request.query;
      const scope = await scopeFor(user);

      if (scope === null) {
        return {
          data: [],
          meta: { page: query.page, perPage: query.perPage, total: 0, totalPages: 1 },
        };
      }

      const where: Prisma.AuditLogWhereInput = { AND: [scope, ...filtersFrom(query)] };
      const [total, rows] = await Promise.all([
        prisma.auditLog.count({ where }),
        prisma.auditLog.findMany({
          where,
          orderBy: { id: 'desc' },
          skip: (query.page - 1) * query.perPage,
          take: query.perPage,
        }),
      ]);

      return {
        data: toAuditEntries(rows),
        meta: {
          page: query.page,
          perPage: query.perPage,
          total,
          totalPages: Math.max(1, Math.ceil(total / query.perPage)),
        },
      };
    },
  );

  app.get(
    '/export',
    {
      preHandler: fastify.authenticate,
      schema: {
        tags: ['audit'],
        summary: 'Stream the audit log as newline-delimited JSON',
        description: 'Same visibility rules as the list endpoint. Streamed in batches; never loads the whole table.',
        querystring: exportQuerySchema,
      },
    },
    async (request, reply) => {
      const { user } = requireAuth(request);
      const scope = await scopeFor(user);

      reply.header('Content-Type', 'application/x-ndjson; charset=utf-8');
      reply.header('Content-Disposition', 'attachment; filename="platter-audit.ndjson"');

      const stream = new Readable({ read() {} });
      reply.send(stream);
      if (scope === null) {
        stream.push(null);
        return;
      }

      const where: Prisma.AuditLogWhereInput = { AND: [scope, ...filtersFrom(request.query)] };
      const { signal } = request;

      void (async () => {
        try {
          let cursor: string | undefined;
          for (;;) {
            if (signal.aborted) break;
            const rows = await prisma.auditLog.findMany({
              where,
              orderBy: { id: 'desc' },
              take: EXPORT_BATCH_SIZE,
              ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
            });
            if (rows.length === 0) break;

            for (const row of rows) {
              const entry = toAuditEntry(row);
              if (entry) stream.push(`${JSON.stringify(entry)}\n`);
            }

            const last = rows[rows.length - 1];
            if (!last || rows.length < EXPORT_BATCH_SIZE) break;
            cursor = last.id;
          }
          stream.push(null);
        } catch (error) {
          request.log.error({ err: error }, 'audit export failed mid-stream');
          stream.destroy(error instanceof Error ? error : new Error('audit export failed'));
        }
      })();

      signal.addEventListener('abort', () => stream.destroy(), { once: true });
    },
  );
};

export default auditRoutes;
