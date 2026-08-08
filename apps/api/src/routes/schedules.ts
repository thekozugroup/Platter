import type { Schedule as ScheduleRow } from '@prisma/client';
import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  SCHEDULE_ACTIONS,
  createScheduleRequestSchema,
  idSchema,
  okSchema,
  scheduleSchema,
  updateScheduleRequestSchema,
  type Schedule,
  type ScheduleAction,
} from '@platter/shared';
import { prisma } from '../db.js';
import { requireServer } from '../plugins/auth.js';
import { badRequest, notFound } from '../lib/errors.js';
import { newId } from '../lib/ids.js';
import { recordAuditFromRequest } from '../services/audit.js';
import { computeNextRun, runScheduleNow } from '../services/scheduler.js';

/**
 * Schedule CRUD lives here; the dispatcher that actually fires them lives in
 * `services/scheduler.ts`. `nextRunAt` is computed with that module's pure
 * `computeNextRun` on every write below, so the running loop never has to special-case a
 * schedule it has not seen a database write for yet.
 */

const serverIdParamSchema = z.object({ serverId: z.string().min(1).max(64) });
const scheduleIdParamSchema = z.object({ serverId: z.string().min(1).max(64), id: idSchema });
const listSchedulesResponseSchema = z.object({ data: z.array(scheduleSchema) });

function toScheduleAction(value: string): ScheduleAction {
  return (SCHEDULE_ACTIONS as readonly string[]).includes(value) ? (value as ScheduleAction) : 'command';
}

function toLastRunStatus(value: string | null): 'success' | 'failed' | 'skipped' | null {
  return value === 'success' || value === 'failed' || value === 'skipped' ? value : null;
}

function toScheduleWire(row: ScheduleRow): Schedule {
  return {
    id: row.id,
    serverId: row.serverId,
    name: row.name,
    cron: row.cron,
    timezone: row.timezone,
    action: toScheduleAction(row.action),
    payload: row.payload,
    enabled: row.enabled,
    onlyWhenOnline: row.onlyWhenOnline,
    lastRunAt: row.lastRunAt?.toISOString() ?? null,
    lastRunStatus: toLastRunStatus(row.lastRunStatus),
    lastRunError: row.lastRunError,
    nextRunAt: row.nextRunAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Every handler re-checks this: a schedule id alone would let one server's schedule be
 * read or acted on through a different server's URL, since ids are globally unique. */
async function loadOwnedSchedule(serverId: string, id: string): Promise<ScheduleRow> {
  const row = await prisma.schedule.findUnique({ where: { id } });
  if (!row || row.serverId !== serverId) throw notFound('schedule');
  return row;
}

const scheduleRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.get(
    '/',
    {
      preHandler: app.requireServerAccess('schedules.read'),
      schema: {
        tags: ['schedules'],
        summary: "List this server's schedules",
        params: serverIdParamSchema,
        response: { 200: listSchedulesResponseSchema },
      },
    },
    async (request) => {
      const rows = await prisma.schedule.findMany({
        where: { serverId: request.params.serverId },
        orderBy: { createdAt: 'desc' },
      });
      return { data: rows.map(toScheduleWire) };
    },
  );

  app.post(
    '/',
    {
      preHandler: app.requireServerAccess('schedules.write'),
      schema: {
        tags: ['schedules'],
        summary: 'Create a schedule',
        params: serverIdParamSchema,
        body: createScheduleRequestSchema,
        response: { 201: scheduleSchema },
      },
    },
    async (request, reply) => {
      const server = requireServer(request);
      const body = request.body;
      // Validated here (cron-parser plus a real timezone check), not just by the shared
      // schema's loose "looks like a cron expression" regex — a schedule that fails this
      // must never reach the database with a `nextRunAt` nobody could compute.
      const nextRunAt = body.enabled ? computeNextRun(body.cron, body.timezone, new Date()) : null;

      const row = await prisma.schedule.create({
        data: {
          id: newId('sch'),
          serverId: server.id,
          name: body.name,
          cron: body.cron,
          timezone: body.timezone,
          action: body.action,
          payload: body.payload,
          enabled: body.enabled,
          onlyWhenOnline: body.onlyWhenOnline,
          nextRunAt,
        },
      });

      await recordAuditFromRequest(request, {
        action: 'schedule.created',
        targetType: 'schedule',
        targetId: row.id,
        targetName: row.name,
        metadata: { serverId: server.id, action: row.action, cron: row.cron },
      });

      reply.code(201);
      return toScheduleWire(row);
    },
  );

  app.get(
    '/:id',
    {
      preHandler: app.requireServerAccess('schedules.read'),
      schema: {
        tags: ['schedules'],
        summary: 'Get one schedule',
        params: scheduleIdParamSchema,
        response: { 200: scheduleSchema },
      },
    },
    async (request) => toScheduleWire(await loadOwnedSchedule(request.params.serverId, request.params.id)),
  );

  app.patch(
    '/:id',
    {
      preHandler: app.requireServerAccess('schedules.write'),
      schema: {
        tags: ['schedules'],
        summary: 'Update a schedule',
        params: scheduleIdParamSchema,
        body: updateScheduleRequestSchema,
        response: { 200: scheduleSchema },
      },
    },
    async (request) => {
      const existing = await loadOwnedSchedule(request.params.serverId, request.params.id);
      const patch = request.body;

      const merged = {
        name: patch.name ?? existing.name,
        cron: patch.cron ?? existing.cron,
        timezone: patch.timezone ?? existing.timezone,
        action: patch.action ?? existing.action,
        payload: patch.payload !== undefined ? patch.payload : existing.payload,
        enabled: patch.enabled ?? existing.enabled,
        onlyWhenOnline: patch.onlyWhenOnline ?? existing.onlyWhenOnline,
      };

      // `createScheduleRequestSchema` enforces "a `command` schedule needs a command" at
      // creation; `updateScheduleRequestSchema` cannot re-check it because it only sees
      // the fields actually sent, not the row they are merging into. Re-checked here
      // against the merged result so a PATCH that flips the action to `command` without
      // also sending a payload cannot slip past it.
      if (merged.action === 'command' && !merged.payload?.trim()) {
        throw badRequest('Enter the command to run.', { payload: ['Enter the command to run.'] });
      }

      const nextRunAt = merged.enabled ? computeNextRun(merged.cron, merged.timezone, new Date()) : null;

      const row = await prisma.schedule.update({
        where: { id: existing.id },
        data: { ...merged, nextRunAt },
      });

      await recordAuditFromRequest(request, {
        action: 'schedule.updated',
        targetType: 'schedule',
        targetId: row.id,
        targetName: row.name,
        metadata: { serverId: row.serverId },
      });

      return toScheduleWire(row);
    },
  );

  app.delete(
    '/:id',
    {
      preHandler: app.requireServerAccess('schedules.write'),
      schema: {
        tags: ['schedules'],
        summary: 'Delete a schedule',
        params: scheduleIdParamSchema,
        response: { 200: okSchema },
      },
    },
    async (request) => {
      const existing = await loadOwnedSchedule(request.params.serverId, request.params.id);
      await prisma.schedule.delete({ where: { id: existing.id } });
      await recordAuditFromRequest(request, {
        action: 'schedule.deleted',
        targetType: 'schedule',
        targetId: existing.id,
        targetName: existing.name,
        metadata: { serverId: existing.serverId },
      });
      return { ok: true as const };
    },
  );

  app.post(
    '/:id/run',
    {
      preHandler: app.requireServerAccess('schedules.write'),
      schema: {
        tags: ['schedules'],
        summary: 'Run a schedule now, independent of its cron (does not move its next run)',
        params: scheduleIdParamSchema,
        response: { 202: okSchema },
      },
    },
    async (request, reply) => {
      const existing = await loadOwnedSchedule(request.params.serverId, request.params.id);
      await runScheduleNow(existing.id, request.auth?.user.id ?? null);
      reply.code(202);
      return { ok: true as const };
    },
  );
};

export default scheduleRoutes;
