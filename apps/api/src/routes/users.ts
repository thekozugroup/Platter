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
} from '@platter/shared';
import { unauthenticated } from '../lib/errors.js';
import type { AuthContext } from '../plugins/auth.js';
import { recordAuditFromRequest } from '../services/audit.js';
import { createUser, deleteUser, getUserDto, listUsers, updateUser } from '../services/users.js';

const userParamsSchema = z.object({ userId: idSchema });
const deleteUserQuerySchema = z.object({
  /** Required when the account still owns servers; see `deleteUser`. */
  transferTo: idSchema.optional(),
});

function requireAuth(request: FastifyRequest): AuthContext {
  if (!request.auth) throw unauthenticated();
  return request.auth;
}

/**
 * Admin user management. Every route requires `admin`; the finer rules — only an owner can
 * grant `owner`, the last owner cannot be touched — live in `services/users.ts` because
 * they must be checked atomically against the write, not re-derived here from a stale read.
 */
const userRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.get(
    '/',
    {
      preHandler: fastify.requireRole('admin'),
      schema: {
        tags: ['users'],
        summary: 'List accounts',
        querystring: paginationQuerySchema,
        response: { 200: paginatedSchema(userSchema) },
      },
    },
    async (request) => listUsers(request.query),
  );

  app.post(
    '/',
    {
      preHandler: fastify.requireRole('admin'),
      schema: {
        tags: ['users'],
        summary: 'Create an account',
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

  app.get(
    '/:userId',
    {
      preHandler: fastify.requireRole('admin'),
      schema: {
        tags: ['users'],
        summary: 'Fetch one account',
        params: userParamsSchema,
        response: { 200: userSchema },
      },
    },
    async (request) => getUserDto(request.params.userId),
  );

  app.patch(
    '/:userId',
    {
      preHandler: fastify.requireRole('admin'),
      schema: {
        tags: ['users'],
        summary: 'Update an account',
        description:
          'Only an owner can grant the owner role, and the last remaining owner can be neither ' +
          'demoted nor suspended. Setting `password` revokes every session and API key the ' +
          'account holds; setting `suspended: true` also suspends the servers it owns.',
        params: userParamsSchema,
        body: updateUserRequestSchema,
        response: { 200: userSchema },
      },
    },
    async (request) => {
      const { user: actor } = requireAuth(request);
      const { user, suspendedNow, passwordChanged } = await updateUser(
        request.params.userId,
        request.body,
        actor,
      );

      await recordAuditFromRequest(request, {
        // A suspension gets its own, more specific audit action; everything else — role,
        // profile fields, an admin-forced password reset — reads as a plain update.
        action: suspendedNow ? 'user.suspended' : 'user.updated',
        targetType: 'user',
        targetId: user.id,
        targetName: user.email,
        // Field names only: a role or suspension flag is safe to log, a password never is.
        metadata: { fields: Object.keys(request.body), passwordChanged },
      });

      return user;
    },
  );

  app.delete(
    '/:userId',
    {
      preHandler: fastify.requireRole('admin'),
      schema: {
        tags: ['users'],
        summary: 'Delete an account',
        description:
          'Refused with a count of servers still owned unless `transferTo` names another, ' +
          'active account to reassign them to first. The last owner cannot be deleted.',
        params: userParamsSchema,
        querystring: deleteUserQuerySchema,
        response: { 200: okSchema },
      },
    },
    async (request) => {
      const deleted = await deleteUser(request.params.userId, request.query.transferTo);

      await recordAuditFromRequest(request, {
        action: 'user.deleted',
        targetType: 'user',
        targetId: request.params.userId,
        targetName: deleted.email,
        metadata: { transferredTo: request.query.transferTo ?? null },
      });

      return { ok: true as const };
    },
  );
};

export default userRoutes;
