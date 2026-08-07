import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import type { FastifyBaseLogger } from 'fastify';
import { config, isProduction } from './config.js';

/**
 * Warnings and errors are emitted as events rather than printed by Prisma itself, so they
 * land in the same structured stream as everything else instead of interleaving raw text
 * with the JSON log.
 */
function createClient(): PrismaClient<{
  log: [{ emit: 'event'; level: 'warn' }, { emit: 'event'; level: 'error' }];
}> {
  return new PrismaClient({
    log: [
      { emit: 'event', level: 'warn' },
      { emit: 'event', level: 'error' },
    ],
  });
}

type DatabaseClient = ReturnType<typeof createClient>;

/**
 * `tsx watch` re-imports this module on every edit. Without the global cache each reload
 * would open a fresh connection pool and leak the previous one until the process dies.
 */
const globalCache = globalThis as typeof globalThis & { __platterPrisma?: DatabaseClient };

export const prisma: DatabaseClient = globalCache.__platterPrisma ?? createClient();

if (!isProduction) globalCache.__platterPrisma = prisma;

let loggingAttached = false;

/** Called once from `buildApp`, after the Fastify logger exists. */
export function attachDatabaseLogging(logger: FastifyBaseLogger): void {
  if (loggingAttached) return;
  loggingAttached = true;

  prisma.$on('warn', (event) => {
    logger.warn({ target: event.target }, event.message);
  });
  prisma.$on('error', (event) => {
    logger.error({ target: event.target }, event.message);
  });
}

/**
 * SQLite will not create the directory holding its database file, and neither will the
 * backup writer. Doing it here means `docker run` with an empty volume just works.
 */
async function ensureStorageDirectories(): Promise<void> {
  const directories = new Set([config.dataDir, config.serversDir, config.backupDir]);

  const fileUrl = /^file:(.+)$/.exec(config.databaseUrl);
  if (fileUrl?.[1]) {
    // Prisma resolves relative SQLite paths against the schema directory, not cwd.
    const schemaDir = path.join(process.cwd(), 'prisma');
    directories.add(path.dirname(path.resolve(schemaDir, fileUrl[1])));
  }

  for (const directory of directories) {
    await mkdir(directory, { recursive: true });
  }
}

export async function connectDatabase(): Promise<void> {
  await ensureStorageDirectories();
  await prisma.$connect();
}

export async function disconnectDatabase(): Promise<void> {
  await prisma.$disconnect();
}
