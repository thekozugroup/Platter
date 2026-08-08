import type { FastifyPluginAsync } from 'fastify';

/**
 * Not yet implemented.
 *
 * The AI assistant (natural-language provisioning, crash diagnosis, chat) is the one
 * surface in `@platter/shared` with no implementation behind it: `schemas/ai.ts` defines
 * the contract and `prisma/schema.prisma` has the `Conversation`/`Message` models, but
 * nothing fills them in.
 *
 * The plugin is still registered so the prefix is reserved and every `/ai/*` path answers
 * with the standard 404 envelope rather than a route that half-works. `GET /system/info`
 * already reports `features.ai: false` (it keys off `ANTHROPIC_API_KEY`), so a client can
 * tell the difference between "off" and "missing" without probing.
 *
 * Note that the *agent-facing* half of the AI story is complete and does not depend on
 * this: `mcp/` exposes 25 tools over MCP, and `services/proposals.ts` implements the
 * propose-then-human-approves flow that keeps a model from ever writing to a server.
 */
const aiRoutes: FastifyPluginAsync = async () => {};

export default aiRoutes;
