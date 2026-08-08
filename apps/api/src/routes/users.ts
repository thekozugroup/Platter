import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  createUserRequestSchema,
  idSchema,
  okSchema,
  paginatedSchema,
  paginationQuerySchema,
  updateUserRequestSchema,
  userSchema,
  USER_ROLES,
} from '@platter/shared';
import { unauthenticated } from '../lib/errors.js';
import type { AuthContext } from '../plugins/auth.js';
import { createUser, deleteUser, getUser, listUsers, updateUser } from '../services/users.js';
import { recordAuditFromRequest } from '../services/audit.js';

/** `requireRole('admin')` already guarantees this; narrows the type for the handler body. */
function requireAuth(request: FastifyRequest): AuthContext {
  if (!request.auth) throw unauthenticated();
  return request.auth;
}

/**
 * Admin user management. Every route here requires `admin`; the *relative* rules — an
 * admin cannot touch an owner, only an owner can grant owner, the last owner is
 * untouchable — are enforced in `services/users.ts`, which is the only place that can do
 * it atomically.
 */

const listUsersQuerySchema = paginationQuerySchema.extend({
  search: z.string().trim().min(1).max(120).optional(),
  role: z.enum(USER_ROLES).optional(),
  suspended: z.coerce.boolean().optional(),
});

const deleteUserQuerySchema = z.object({
  /** Reassign the target's servers here instead of refusing the delete. */
  transferTo: idSchema.optional(),
});

const userRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.get(
    '/',
    {
      preHandler: app.requireRole('admin'),
      schema: {
        tags: ['users'],
        summary: 'List accounts',
        querystring: listUsersQuerySchema,
        response: { 200: paginatedSchema(userSchema) },
      },
    },
    async (request) => {
      const { page, perPage, search, role, suspended } = request.query;
      return listUsers({ page, perPage, search, role, suspended });
    },
  );

  app.get(
    '/:id',
    {
      preHandler: app.requireRole('admin'),
      schema: {
        tags: ['users'],
        summary: 'Get one account',
        params: z.object({ id: idSchema }),
        response: { 200: userSchema },
      },
    },
    async (request) => getUser(request.params.id),
  );

  app.post(
    '/',
    {
      preHandler: app.requireRole('admin'),
      schema: {
        tags: ['users'],
        summary: 'Create an account',
        description:
          'Only an owner may set `role: "owner"` here — an admin creating an owner ' +
          'account would be a self-service escalation with an extra step.',
        body: createUserRequestSchema,
        response: { 201: userSchema },
      },
    },
    async (request, reply) => {
      const { user: actor } = requireAuth(request);
      const created = await createUser(request.body, actor);

      await recordAuditFromRequest(request, {
        action: 'user.created',
        targetType: 'user',
        targetId: created.id,
        targetName: created.email,
        metadata: { role: created.role },
      });

      return reply.status(201).send(created);
    },
  );

  app.patch(
    '/:id',
    {
      preHandler: app.requireRole('admin'),
      schema: {
        tags: ['users'],
        summary: 'Update an account',
        description:
          'Changing `password` revokes every session and API key the account holds. Setting ' +
          '`suspended: true` also suspends every server it owns.',
        params: z.object({ id: idSchema }),
        body: updateUserRequestSchema,
        response: { 200: userSchema },
      },
    },
    async (request) => {
      const { user: actor } = requireAuth(request);
      const updated = await updateUser(request.params.id, request.body, actor, {
        logger: request.log,
      });

      const fields = Object.keys(request.body);
      if (request.body.suspended === true) {
        await recordAuditFromRequest(request, {
          action: 'user.suspended',
          targetType: 'user',
          targetId: updated.id,
          targetName: updated.email,
          metadata: { fields },
        });
      } else {
        await recordAuditFromRequest(request, {
          action: 'user.updated',
          targetType: 'user',
          targetId: updated.id,
          targetName: updated.email,
          metadata: { fields },
        });
      }

      return updated;
    },
  );

  app.delete(
    '/:id',
    {
      preHandler: app.requireRole('admin'),
      schema: {
        tags: ['users'],
        summary: 'Delete an account',
        description:
          'Refused with `conflict` if the account owns any servers, unless `transferTo` names ' +
          'another account to reassign them to.',
        params: z.object({ id: idSchema }),
        querystring: deleteUserQuerySchema,
        response: { 200: okSchema },
      },
    },
    async (request) => {
      const { user: actor } = requireAuth(request);
      const target = await getUser(request.params.id);

      await deleteUser(request.params.id, actor, { transferTo: request.query.transferTo ?? null });

      await recordAuditFromRequest(request, {
        action: 'user.deleted',
        targetType: 'user',
        targetId: target.id,
        targetName: target.email,
        metadata: request.query.transferTo ? { transferredTo: request.query.transferTo } : {},
      });

      return { ok: true as const };
    },
  );
};

export default userRoutes;
