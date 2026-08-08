import { createRequire } from 'node:module';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { config } from '../config.js';
import { prisma } from '../db.js';
import { getDriverForNode } from '../orchestration/registry.js';
import { recordAuditFromRequest } from '../services/audit.js';
import { renderMetrics } from '../services/metrics.js';

/**
 * Everything that answers "is Platter itself okay", plus the two admin-facing surfaces
 * that do not belong anywhere more specific: runtime settings and the Prometheus scrape.
 *
 * `/health`, `/ready` and `/info` are deliberately unauthenticated. An orchestrator's
 * healthcheck has no credentials to present, and the login screen needs `/info`'s
 * `needsSetup` before anyone has signed in at all — that is the one piece of "is this
 * installation configured yet" a fresh instance can answer.
 */

// `package.json` is read once, at boot, not per request — the version cannot change while
// the process is running, so there is nothing to gain from re-reading the file every time.
const require = createRequire(import.meta.url);
const APP_VERSION: string = (require('../../package.json') as { version: string }).version;

// ---------------------------------------------------------------------------
// Health / readiness
// ---------------------------------------------------------------------------

const healthSchema = z.object({ status: z.literal('ok') });

const readinessCheckSchema = z.object({ ok: z.boolean(), error: z.string().nullable() });
const readinessSchema = z.object({
  ok: z.boolean(),
  checks: z.object({ database: readinessCheckSchema, nodes: readinessCheckSchema }),
});
type ReadinessCheck = z.infer<typeof readinessCheckSchema>;

async function checkDatabase(): Promise<ReadinessCheck> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return { ok: true, error: null };
  } catch {
    return { ok: false, error: 'The database is not reachable.' };
  }
}

/**
 * At least one node's driver must actually answer — not "the last background poll thought
 * so a while ago". `driver.health()` is contractually total (it never throws) and carries
 * its own timeout, so probing every node live here is bounded and safe to do on every
 * `docker healthcheck` tick.
 */
async function checkNodes(): Promise<ReadinessCheck> {
  try {
    const nodes = await prisma.node.findMany();
    if (nodes.length === 0) return { ok: false, error: 'No nodes are configured.' };

    const results = await Promise.all(nodes.map((node) => getDriverForNode(node).health()));
    const reachable = results.some((health) => health.reachable);
    return reachable
      ? { ok: true, error: null }
      : { ok: false, error: 'No configured node is reachable.' };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Could not check node health.',
    };
  }
}

// ---------------------------------------------------------------------------
// Info
// ---------------------------------------------------------------------------

const systemInfoSchema = z.object({
  version: z.string(),
  uptimeSeconds: z.number().int(),
  /** True until the first account exists — the client's cue to show account setup instead
   * of a login form. */
  needsSetup: z.boolean(),
  counts: z.object({
    users: z.number().int(),
    servers: z.number().int(),
    nodes: z.number().int(),
  }),
  features: z.object({
    ai: z.boolean(),
    metrics: z.boolean(),
    registrationEnabled: z.boolean(),
  }),
});

// ---------------------------------------------------------------------------
// Settings — a small, validated key/value catalogue backed by the `Setting` model
// ---------------------------------------------------------------------------

const SETTINGS_CATALOG = {
  /** Shown in the browser tab and header; purely cosmetic. */
  siteName: { schema: z.string().trim().min(1).max(80), default: 'Platter' },
  /** Optional banner text for the dashboard. */
  motd: { schema: z.string().trim().max(500), default: '' },
} as const;

// `-readonly` because `SETTINGS_CATALOG` is `as const`: a plain homomorphic mapped type
// would otherwise copy that readonly-ness onto every property of the shape below, and
// `getSettings` builds one of these field by field.
type SettingsShape = {
  -readonly [K in keyof typeof SETTINGS_CATALOG]: z.infer<(typeof SETTINGS_CATALOG)[K]['schema']>;
};

const settingsSchema = z.object({
  siteName: SETTINGS_CATALOG.siteName.schema,
  motd: SETTINGS_CATALOG.motd.schema,
});

const updateSettingsRequestSchema = z
  .object({
    siteName: SETTINGS_CATALOG.siteName.schema.optional(),
    motd: SETTINGS_CATALOG.motd.schema.optional(),
  })
  .refine((body) => Object.keys(body).length > 0, 'Nothing to update');

const SETTINGS_KEYS = Object.keys(SETTINGS_CATALOG) as (keyof SettingsShape)[];

async function getSettings(): Promise<SettingsShape> {
  const rows = await prisma.setting.findMany({ where: { key: { in: SETTINGS_KEYS } } });
  const stored = new Map(rows.map((row) => [row.key, row.value]));

  const result = {} as SettingsShape;
  for (const key of SETTINGS_KEYS) {
    const raw = stored.get(key);
    const definition = SETTINGS_CATALOG[key];
    if (raw === undefined) {
      result[key] = definition.default;
      continue;
    }
    // A row written by a future build, or edited by hand, degrades to the default rather
    // than surfacing a broken value — the same philosophy `services/audit.ts` applies to
    // an unrecognised action.
    try {
      const parsed = definition.schema.safeParse(JSON.parse(raw));
      result[key] = parsed.success ? parsed.data : definition.default;
    } catch {
      result[key] = definition.default;
    }
  }
  return result;
}

async function updateSettings(patch: Partial<SettingsShape>): Promise<SettingsShape> {
  const writes = Object.entries(patch).map(([key, value]) =>
    prisma.setting.upsert({
      where: { key },
      create: { key, value: JSON.stringify(value) },
      update: { value: JSON.stringify(value) },
    }),
  );
  if (writes.length > 0) await prisma.$transaction(writes);
  return getSettings();
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

const systemRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.get(
    '/health',
    {
      schema: {
        tags: ['system'],
        summary: 'Liveness probe',
        description:
          'Answers as soon as the process can serve HTTP. Never checks the database or a node.',
        security: [],
        response: { 200: healthSchema },
      },
    },
    async () => ({ status: 'ok' as const }),
  );

  app.get(
    '/ready',
    {
      schema: {
        tags: ['system'],
        summary: 'Readiness probe',
        description:
          'The database and at least one node must both answer, or this returns 503 with a breakdown.',
        security: [],
        response: { 200: readinessSchema, 503: readinessSchema },
      },
    },
    async (_request, reply) => {
      const [database, nodes] = await Promise.all([checkDatabase(), checkNodes()]);
      const ok = database.ok && nodes.ok;
      return reply.status(ok ? 200 : 503).send({ ok, checks: { database, nodes } });
    },
  );

  app.get(
    '/info',
    {
      schema: {
        tags: ['system'],
        summary: 'Version, uptime and feature flags',
        security: [],
        response: { 200: systemInfoSchema },
      },
    },
    async () => {
      const [users, servers, nodes] = await Promise.all([
        prisma.user.count(),
        prisma.server.count(),
        prisma.node.count(),
      ]);
      return {
        version: APP_VERSION,
        uptimeSeconds: Math.floor(process.uptime()),
        needsSetup: users === 0,
        counts: { users, servers, nodes },
        features: {
          ai: config.aiEnabled,
          metrics: config.metricsEnabled,
          registrationEnabled: config.registrationEnabled,
        },
      };
    },
  );

  app.get(
    '/settings',
    {
      preHandler: app.requireRole('admin'),
      schema: {
        tags: ['system'],
        summary: 'Read runtime settings',
        response: { 200: settingsSchema },
      },
    },
    async () => getSettings(),
  );

  app.patch(
    '/settings',
    {
      preHandler: app.requireRole('owner'),
      schema: {
        tags: ['system'],
        summary: 'Change runtime settings',
        body: updateSettingsRequestSchema,
        response: { 200: settingsSchema },
      },
    },
    async (request) => {
      const updated = await updateSettings(request.body);
      await recordAuditFromRequest(request, {
        action: 'settings.updated',
        targetType: 'system',
        metadata: { fields: Object.keys(request.body) },
      });
      return updated;
    },
  );

  app.get(
    '/metrics',
    {
      preHandler: app.requireRole('admin'),
      schema: {
        tags: ['system'],
        summary: 'Prometheus metrics',
        description:
          'Text-format exposition for a Prometheus scrape config. Prometheus cannot hold a ' +
          'short-lived bearer token, so scrape this with a long-lived API key in `X-API-Key`.',
      },
    },
    async (_request, reply) => {
      const { contentType, body } = await renderMetrics();
      reply.header('content-type', contentType);
      return reply.send(body);
    },
  );
};

export default systemRoutes;
