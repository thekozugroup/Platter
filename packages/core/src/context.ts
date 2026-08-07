import { mkdirSync } from 'node:fs';
import type { PlatterDatabase } from '@platter/db';
import { applyMigrations, getDatabase } from '@platter/db';
import { ok, paths, type Result } from '@platter/shared';
import { type Env, loadEnv } from '@platter/shared/env';
import type Docker from 'dockerode';
import { checkDocker, createDockerClient, ensureNetwork } from './docker/client';

/**
 * The shared runtime context.
 *
 * Everything stateful — the database handle, the Docker client, the resolved configuration —
 * lives here and is passed explicitly rather than imported as a module singleton. Three reasons:
 * tests can construct a context against an in-memory database and a fake Docker, the MCP server
 * and the web app can share one, and it makes the dependency graph visible at every call site
 * instead of hiding it behind imports.
 */
export interface Context {
  env: Env;
  db: PlatterDatabase;
  docker: Docker;
}

export interface InitOptions {
  /** Override the environment. Tests pass a synthetic one. */
  env?: Env;
  /** Skip Docker connectivity checks and network creation. */
  skipDocker?: boolean;
}

/**
 * Build the context and make the world ready: directories exist, migrations are applied, the
 * Docker network is present.
 *
 * Migrations run automatically. A local app that refuses to start until you remember to run a
 * migration command is a local app people file bugs against on day one.
 */
export async function createContext(options: InitOptions = {}): Promise<Result<Context>> {
  const env = options.env ?? loadEnv();

  const root = env.PLATTER_DATA_DIR;
  for (const dir of [root, paths.servers(root), paths.modCache(root), paths.tmp(root)]) {
    mkdirSync(dir, { recursive: true });
  }

  const db = getDatabase({ path: paths.db(root), debug: env.PLATTER_LOG_LEVEL === 'debug' });
  applyMigrations(db);

  const docker = createDockerClient({
    socket: env.PLATTER_DOCKER_SOCKET,
    dockerHost: env.DOCKER_HOST,
  });

  const skipDocker = options.skipDocker ?? env.PLATTER_SKIP_DOCKER;
  if (!skipDocker) {
    const health = await checkDocker(docker, env.PLATTER_DOCKER_SOCKET);
    if (!health.ok) {
      return health;
    }
    const network = await ensureNetwork(docker, env.PLATTER_DOCKER_NETWORK);
    if (!network.ok) {
      return network;
    }
  }

  return ok({ env, db, docker });
}
