import type { FastifyPluginAsync } from 'fastify';
import type { RateLimitOptions } from '@fastify/rate-limit';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { requireServer } from '../plugins/auth.js';
import { modSourceSchema } from '../mods/registry.js';
import { installedModSchema, resolutionSchema } from '../mods/resolve.js';
import {
  PROPOSAL_STATUSES,
  approve,
  getProposal,
  listProposals,
  modProposalSchema,
  proposalChangeSchema,
  propose,
  reject,
} from '../services/proposals.js';
import { clientAbortSignal } from './mods.js';

/**
 * The review queue.
 *
 * These routes are the only path from a proposal to an installed file, and the permissions
 * split reflects that: `ai.use` is enough to *suggest* a mod, `files.write` is required to
 * approve one. An agent given an API key scoped to `ai.use` can fill this queue and cannot
 * empty it.
 */

/** Proposing costs an upstream resolution, so it is budgeted separately from reads. */
const PROPOSE_RATE_LIMIT: RateLimitOptions = { max: 10, timeWindow: '1 minute' };

/** Approval downloads files. Slow on purpose — nothing legitimate approves in bulk. */
const REVIEW_RATE_LIMIT: RateLimitOptions = { max: 20, timeWindow: '1 minute' };

const serverIdParamSchema = z.object({ serverId: z.string().min(1).max(64) });
const proposalParamSchema = serverIdParamSchema.extend({ id: z.string().min(3).max(64) });

const createProposalSchema = z.object({
  source: modSourceSchema,
  /** Project id or slug. */
  project: z.string().min(1).max(128),
  /** Omit to let Platter pick the newest version this server can load. */
  version: z.string().min(1).max(128).nullish(),
  /** Why this mod, in the proposer's own words. This is what the reviewer reads first. */
  rationale: z.string().trim().min(3).max(2000),
});

const rejectProposalSchema = z.object({
  note: z.string().trim().max(1000).nullish(),
});

const approveProposalSchema = z.object({
  /**
   * The digest the reviewer saw. Only needed when a previous attempt reported that upstream
   * had changed: passing the new digest back is how the reviewer says "I read the diff".
   */
  acknowledgedDigest: z.string().min(16).max(128).nullish(),
});

/**
 * One shape for all three outcomes rather than a union.
 *
 * `installed` is 200; `changed` and `blocked` are 409 with the same body, so a client parses
 * one schema and switches on `status` — and cannot mistake "nothing was installed" for
 * success because `installed` is empty and the code is not 2xx.
 */
const approvalOutcomeSchema = z.object({
  status: z.enum(['installed', 'changed', 'blocked']),
  proposal: modProposalSchema,
  installed: z.array(installedModSchema),
  resolution: resolutionSchema,
  changes: z.array(proposalChangeSchema),
  digest: z.string(),
});

const proposalRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.get(
    '/',
    {
      preHandler: app.requireServerAccess('server.view'),
      schema: {
        tags: ['proposals'],
        summary: 'List mod proposals for this server',
        params: serverIdParamSchema,
        querystring: z.object({ status: z.enum(PROPOSAL_STATUSES).optional() }),
        response: { 200: z.object({ data: z.array(modProposalSchema) }) },
      },
    },
    async (request) => ({
      data: await listProposals(request.params.serverId, request.query.status, request.log),
    }),
  );

  app.post(
    '/',
    {
      // `ai.use`, not `files.write`: proposing is the agent-facing half of the workflow and
      // must be grantable without any ability to change the server.
      preHandler: app.requireServerAccess('ai.use'),
      config: { rateLimit: PROPOSE_RATE_LIMIT },
      schema: {
        tags: ['proposals'],
        summary: 'Propose a mod for review. Installs nothing.',
        params: serverIdParamSchema,
        body: createProposalSchema,
        response: { 201: modProposalSchema },
      },
    },
    async (request, reply) => {
      const server = requireServer(request);
      const actor = request.auth?.user ?? null;
      const proposal = await propose({
        server,
        source: request.body.source,
        projectRef: request.body.project,
        versionRef: request.body.version ?? null,
        rationale: request.body.rationale,
        proposedById: actor?.id ?? null,
        proposedByName: actor?.displayName ?? null,
        signal: clientAbortSignal(reply),
        log: request.log,
      });
      reply.code(201);
      return proposal;
    },
  );

  app.get(
    '/:id',
    {
      preHandler: app.requireServerAccess('server.view'),
      schema: {
        tags: ['proposals'],
        summary: 'Get one proposal, with the snapshot the reviewer approves against',
        params: proposalParamSchema,
        response: { 200: modProposalSchema },
      },
    },
    async (request) => getProposal(request.params.serverId, request.params.id, request.log),
  );

  app.post(
    '/:id/approve',
    {
      // The gate. Approving installs executable code, so it needs the permission that governs
      // writing files — never `ai.use`.
      preHandler: app.requireServerAccess('files.write'),
      config: { rateLimit: REVIEW_RATE_LIMIT },
      schema: {
        tags: ['proposals'],
        summary: 'Approve a proposal, re-resolving against current state first',
        params: proposalParamSchema,
        body: approveProposalSchema,
        response: { 200: approvalOutcomeSchema, 409: approvalOutcomeSchema },
      },
    },
    async (request, reply) => {
      const server = requireServer(request);
      const actor = request.auth?.user ?? null;
      const outcome = await approve(server, request.params.id, {
        reviewerId: actor?.id ?? null,
        reviewerName: actor?.displayName ?? null,
        acknowledgedDigest: request.body.acknowledgedDigest ?? null,
        ip: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
        signal: clientAbortSignal(reply),
        log: request.log,
      });
      // 409 for both non-install outcomes: the request conflicts with the world as it is now,
      // and the body says exactly how.
      if (outcome.status !== 'installed') reply.code(409);
      return outcome;
    },
  );

  app.post(
    '/:id/reject',
    {
      preHandler: app.requireServerAccess('files.write'),
      config: { rateLimit: REVIEW_RATE_LIMIT },
      schema: {
        tags: ['proposals'],
        summary: 'Reject a proposal',
        params: proposalParamSchema,
        body: rejectProposalSchema,
        response: { 200: modProposalSchema },
      },
    },
    async (request) => {
      const server = requireServer(request);
      const actor = request.auth?.user ?? null;
      return reject(server, request.params.id, request.body.note ?? null, {
        reviewerId: actor?.id ?? null,
        reviewerName: actor?.displayName ?? null,
        ip: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
        log: request.log,
      });
    },
  );
};

export default proposalRoutes;
