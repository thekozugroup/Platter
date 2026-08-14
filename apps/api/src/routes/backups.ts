import { createReadStream } from 'node:fs';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  backupSchema,
  createBackupRequestSchema,
  idSchema,
  okSchema,
  restoreBackupRequestSchema,
} from '@platter/shared';
import { requireServer } from '../plugins/auth.js';
import { notFound } from '../lib/errors.js';
import {
  createBackup,
  deleteBackup,
  getBackup,
  getBackupDownload,
  listBackups,
  restoreBackup,
  setBackupLocked,
  toBackupWire,
} from '../services/backups.js';

/**
 * Backups over HTTP.
 *
 * `services/backups.ts` owns its own audit trail (`backup.created` / `.restored` /
 * `.deleted`) rather than the routes recording it, unlike the power/console routes: a
 * backup's archive is built in the background, well after this handler has already
 * returned, so the service is the only thing present when the operation actually finishes.
 */

const serverIdParamSchema = z.object({ serverId: z.string().min(1).max(64) });
const backupIdParamSchema = z.object({ serverId: z.string().min(1).max(64), id: idSchema });
const listBackupsResponseSchema = z.object({ data: z.array(backupSchema) });
const lockBackupRequestSchema = z.object({ locked: z.boolean() });
const restoreResponseSchema = z.object({ ok: z.literal(true), stoppedServer: z.boolean() });

/** Every handler below re-checks this: `id` alone would let one server's backup id be
 * read or acted on through a different server's URL, since ids are globally unique. */
async function loadOwnedBackup(serverId: string, id: string) {
  const row = await getBackup(id);
  if (row.serverId !== serverId) throw notFound('backup');
  return row;
}

const backupRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.get(
    '/',
    {
      preHandler: app.requireServerAccess('backups.read'),
      schema: {
        tags: ['backups'],
        summary: "List this server's backups",
        params: serverIdParamSchema,
        response: { 200: listBackupsResponseSchema },
      },
    },
    async (request) => ({ data: (await listBackups(request.params.serverId)).map(toBackupWire) }),
  );

  app.post(
    '/',
    {
      preHandler: app.requireServerAccess('backups.create'),
      schema: {
        tags: ['backups'],
        summary: 'Start a backup (returns immediately; the archive builds in the background)',
        params: serverIdParamSchema,
        body: createBackupRequestSchema,
        response: { 202: backupSchema },
      },
    },
    async (request, reply) => {
      const server = requireServer(request);
      const row = await createBackup(server.id, {
        name: request.body.name ?? null,
        ignore: request.body.ignore,
        locked: request.body.locked,
        automatic: false,
        actorId: request.auth?.user.id ?? null,
      });
      reply.code(202);
      return toBackupWire(row);
    },
  );

  app.get(
    '/:id',
    {
      preHandler: app.requireServerAccess('backups.read'),
      schema: {
        tags: ['backups'],
        summary: 'Get one backup',
        params: backupIdParamSchema,
        response: { 200: backupSchema },
      },
    },
    async (request) =>
      toBackupWire(await loadOwnedBackup(request.params.serverId, request.params.id)),
  );

  app.get(
    '/:id/download',
    {
      preHandler: app.requireServerAccess('backups.read'),
      schema: {
        tags: ['backups'],
        summary: 'Download a backup archive',
        params: backupIdParamSchema,
      },
    },
    async (request, reply) => {
      const download = await getBackupDownload(request.params.serverId, request.params.id);
      reply
        .header('content-type', 'application/gzip')
        .header('content-length', download.sizeBytes)
        .header('content-disposition', `attachment; filename="${download.filename}"`);
      return createReadStream(download.absolutePath);
    },
  );

  app.patch(
    '/:id',
    {
      // Gated behind the same permission as deletion: locking/unlocking only ever changes
      // whether this backup *can* be deleted, so it belongs to the same grant.
      preHandler: app.requireServerAccess('backups.delete'),
      schema: {
        tags: ['backups'],
        summary: 'Lock or unlock a backup (locked backups cannot be deleted or rotated)',
        params: backupIdParamSchema,
        body: lockBackupRequestSchema,
        response: { 200: backupSchema },
      },
    },
    async (request) => {
      await loadOwnedBackup(request.params.serverId, request.params.id);
      return toBackupWire(await setBackupLocked(request.params.id, request.body.locked));
    },
  );

  app.delete(
    '/:id',
    {
      preHandler: app.requireServerAccess('backups.delete'),
      schema: {
        tags: ['backups'],
        summary: 'Delete a backup',
        params: backupIdParamSchema,
        response: { 200: okSchema },
      },
    },
    async (request) => {
      await loadOwnedBackup(request.params.serverId, request.params.id);
      await deleteBackup(request.params.id, request.auth?.user.id ?? null);
      return { ok: true as const };
    },
  );

  app.post(
    '/:id/restore',
    {
      preHandler: app.requireServerAccess('backups.restore'),
      schema: {
        tags: ['backups'],
        summary: 'Restore a backup onto its server (stops the server first if it is running)',
        params: backupIdParamSchema,
        body: restoreBackupRequestSchema,
        response: { 200: restoreResponseSchema },
      },
    },
    async (request) => {
      await loadOwnedBackup(request.params.serverId, request.params.id);
      const result = await restoreBackup(request.params.id, {
        truncate: request.body.truncate,
        actorId: request.auth?.user.id ?? null,
      });
      return { ok: true as const, stoppedServer: result.stoppedServer };
    },
  );
};

export default backupRoutes;
