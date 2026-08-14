import { createReadStream } from 'node:fs';
import path from 'node:path';
import fastifyMultipart from '@fastify/multipart';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  LIMITS,
  compressFilesRequestSchema,
  createDirectoryRequestSchema,
  deleteFilesRequestSchema,
  extractArchiveRequestSchema,
  fileEntrySchema,
  listFilesQuerySchema,
  listFilesResponseSchema,
  readFileQuerySchema,
  readFileResponseSchema,
  renameFileRequestSchema,
  serverPathSchema,
  writeFileRequestSchema,
} from '@platter/shared';
import { requireServer } from '../plugins/auth.js';
import { badRequest } from '../lib/errors.js';
import { recordAuditFromRequest } from '../services/audit.js';
import {
  compressServerPaths,
  copyServerPath,
  createServerDirectory,
  deleteServerPaths,
  extractServerArchive,
  getServerFileForDownload,
  listServerFiles,
  readServerFile,
  renameServerPath,
  writeServerFile,
  writeServerFileStream,
} from '../services/files.js';

/**
 * The server's file manager over HTTP.
 *
 * Path safety is entirely `services/files.ts`'s job — every handler below just forwards
 * the schema-validated path straight through and lets that module decide whether it is
 * actually inside the server's directory. Nothing here re-derives a filesystem path.
 */

const copyFileRequestSchema = z.object({ from: serverPathSchema, to: serverPathSchema });
const deleteFilesResponseSchema = z.object({ deleted: z.array(z.string()) });
const uploadQuerySchema = z.object({ path: serverPathSchema.default('') });

/**
 * Deliberately looser than an id's real shape (mirrors `blueprintRoutes`'s `:key` param):
 * this only exists so `request.params.serverId` is typed, and a malformed id must reach
 * `requireServerAccess` and come back as the same 404 a missing-but-well-formed one does,
 * not a 422 that tells a prober the difference.
 */
const serverIdParamSchema = z.object({ serverId: z.string().min(1).max(64) });

/** RFC 5987, so a filename with spaces, quotes or non-ASCII characters survives the header. */
function contentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7E]/g, '_').replace(/"/g, "'");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

/** The multipart part only ever gives us the client's claimed filename — never a path. */
function sanitiseUploadName(rawName: string): string {
  const cleaned = path.basename(rawName.replace(/\\/g, '/')).trim();
  if (cleaned.length === 0 || cleaned === '.' || cleaned === '..') {
    throw badRequest('That file has no usable name.');
  }
  return cleaned;
}

const fileRoutes: FastifyPluginAsync = async (fastify) => {
  // Registered in this plugin's own encapsulation only: every other route keeps the 2 MiB
  // JSON body limit from `plugins/security.ts`, and only the upload route below needs the
  // much larger, streamed one.
  await fastify.register(fastifyMultipart, {
    limits: { fileSize: LIMITS.maxUploadBytes, files: 1 },
  });

  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.get(
    '/',
    {
      preHandler: app.requireServerAccess('files.read'),
      schema: {
        tags: ['files'],
        summary: 'List a folder in the server data volume',
        params: serverIdParamSchema,
        querystring: listFilesQuerySchema,
        response: { 200: listFilesResponseSchema },
      },
    },
    async (request) => listServerFiles(request.params.serverId, request.query.path),
  );

  app.get(
    '/content',
    {
      preHandler: app.requireServerAccess('files.read'),
      schema: {
        tags: ['files'],
        summary: 'Read a text file',
        params: serverIdParamSchema,
        querystring: readFileQuerySchema,
        response: { 200: readFileResponseSchema },
      },
    },
    async (request) => readServerFile(request.params.serverId, request.query.path),
  );

  app.get(
    '/download',
    {
      preHandler: app.requireServerAccess('files.read'),
      schema: {
        tags: ['files'],
        summary: 'Download a file',
        params: serverIdParamSchema,
        querystring: readFileQuerySchema,
      },
    },
    async (request, reply) => {
      const file = await getServerFileForDownload(request.params.serverId, request.query.path);
      reply
        .header('content-type', file.mimeType ?? 'application/octet-stream')
        .header('content-length', file.sizeBytes)
        .header('content-disposition', contentDisposition(file.name));
      return createReadStream(file.absolutePath);
    },
  );

  app.put(
    '/content',
    {
      preHandler: app.requireServerAccess('files.write'),
      schema: {
        tags: ['files'],
        summary: 'Write a text file (atomic — a crash mid-save cannot truncate it)',
        params: serverIdParamSchema,
        body: writeFileRequestSchema,
        response: { 200: fileEntrySchema },
      },
    },
    async (request) => {
      const server = requireServer(request);
      const entry = await writeServerFile(server.id, request.body.path, request.body.content);
      await recordAuditFromRequest(request, {
        action: 'file.written',
        targetType: 'server',
        targetId: server.id,
        targetName: server.name,
        metadata: { path: entry.path },
      });
      return entry;
    },
  );

  app.post(
    '/directories',
    {
      preHandler: app.requireServerAccess('files.write'),
      schema: {
        tags: ['files'],
        summary: 'Create a folder',
        params: serverIdParamSchema,
        body: createDirectoryRequestSchema,
        response: { 201: fileEntrySchema },
      },
    },
    async (request, reply) => {
      const entry = await createServerDirectory(request.params.serverId, request.body.path);
      reply.code(201);
      return entry;
    },
  );

  app.post(
    '/rename',
    {
      preHandler: app.requireServerAccess('files.write'),
      schema: {
        tags: ['files'],
        summary: 'Rename or move a file or folder',
        params: serverIdParamSchema,
        body: renameFileRequestSchema,
        response: { 200: fileEntrySchema },
      },
    },
    async (request) => {
      const server = requireServer(request);
      const entry = await renameServerPath(server.id, request.body.from, request.body.to);
      await recordAuditFromRequest(request, {
        action: 'file.renamed',
        targetType: 'server',
        targetId: server.id,
        targetName: server.name,
        metadata: { from: request.body.from, to: entry.path },
      });
      return entry;
    },
  );

  app.post(
    '/copy',
    {
      preHandler: app.requireServerAccess('files.write'),
      schema: {
        tags: ['files'],
        summary: 'Copy a file or folder',
        params: serverIdParamSchema,
        body: copyFileRequestSchema,
        response: { 201: fileEntrySchema },
      },
    },
    async (request, reply) => {
      const entry = await copyServerPath(
        request.params.serverId,
        request.body.from,
        request.body.to,
      );
      reply.code(201);
      return entry;
    },
  );

  app.post(
    '/delete',
    {
      preHandler: app.requireServerAccess('files.delete'),
      schema: {
        tags: ['files'],
        summary: 'Delete one or more files or folders',
        params: serverIdParamSchema,
        body: deleteFilesRequestSchema,
        response: { 200: deleteFilesResponseSchema },
      },
    },
    async (request) => {
      const server = requireServer(request);
      const result = await deleteServerPaths(server.id, request.body.paths);
      await recordAuditFromRequest(request, {
        action: 'file.deleted',
        targetType: 'server',
        targetId: server.id,
        targetName: server.name,
        metadata: { paths: result.deleted },
      });
      return result;
    },
  );

  app.post(
    '/compress',
    {
      preHandler: app.requireServerAccess('files.write'),
      schema: {
        tags: ['files'],
        summary: 'Archive files or folders into a .tar.gz',
        params: serverIdParamSchema,
        body: compressFilesRequestSchema,
        response: { 201: fileEntrySchema },
      },
    },
    async (request, reply) => {
      const entry = await compressServerPaths(
        request.params.serverId,
        request.body.paths,
        request.body.destination,
      );
      reply.code(201);
      return entry;
    },
  );

  app.post(
    '/extract',
    {
      preHandler: app.requireServerAccess('files.write'),
      schema: {
        tags: ['files'],
        summary: 'Extract a .tar/.tar.gz archive',
        params: serverIdParamSchema,
        body: extractArchiveRequestSchema,
        response: { 200: fileEntrySchema },
      },
    },
    async (request) =>
      extractServerArchive(request.params.serverId, request.body.path, request.body.destination, {
        // The server's own disk allowance is the budget. Without it a `files.write`
        // collaborator can loop an archive that unpacks a thousand times over and fill the
        // node for every server sharing it.
        maxTotalBytes: requireServer(request).diskMb * 1024 * 1024,
      }),
  );

  app.post(
    '/upload',
    {
      preHandler: app.requireServerAccess('files.write'),
      schema: {
        tags: ['files'],
        summary: 'Upload a file (multipart, streamed straight to disk)',
        params: serverIdParamSchema,
        querystring: uploadQuerySchema,
        response: { 201: fileEntrySchema },
      },
    },
    async (request, reply) => {
      const server = requireServer(request);
      const file = await request.file();
      if (!file) throw badRequest('No file was uploaded.');

      const name = sanitiseUploadName(file.filename);
      const targetPath = request.query.path === '' ? name : `${request.query.path}/${name}`;
      const entry = await writeServerFileStream(server.id, targetPath, file.file);

      await recordAuditFromRequest(request, {
        action: 'file.uploaded',
        targetType: 'server',
        targetId: server.id,
        targetName: server.name,
        metadata: { path: entry.path, sizeBytes: entry.sizeBytes },
      });
      reply.code(201);
      return entry;
    },
  );
};

export default fileRoutes;
