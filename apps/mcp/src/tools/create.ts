import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  availableLoaders,
  type Context,
  createServer,
  getVersionIndex,
  selectImage,
} from '@platter/core';
import { isErr, LOADER_LABELS, type MinecraftLoader } from '@platter/shared';
import { z } from 'zod';
import { proposeAndConfirm, recordOutcome } from '../confirm';
import { result, toolError } from '../format';

/**
 * Creating a server.
 *
 * Split into its own file because it is the one tool that brings something into existence rather
 * than acting on something the user already has, and it carries two obligations the others do
 * not: the EULA has to be accepted by a person, and the loader/version pair has to be checked
 * before a container is pulled rather than after.
 *
 * The EULA point is not a formality. Accepting Mojang's licence is a legal act by the server's
 * operator, and a model cannot perform it on their behalf. So the confirmation dialog states it
 * plainly and the tool's own `acceptEula` argument does not exist — the human's "yes" in the
 * elicitation *is* the acceptance, which is the only place it can honestly live.
 */
const LOADERS: readonly MinecraftLoader[] = [
  'vanilla',
  'paper',
  'purpur',
  'spigot',
  'folia',
  'fabric',
  'forge',
  'neoforge',
  'quilt',
];

export function registerCreateTools(server: McpServer, ctx: Context): void {
  server.registerTool(
    'list_minecraft_versions',
    {
      title: 'List Minecraft versions',
      description:
        'List the Minecraft versions a server can be created on, newest first, with the mod ' +
        'loaders that have builds for each. Call this before create_server — a loader with no ' +
        'builds for a version fails minutes into creation, not at the point you choose it.',
      inputSchema: {
        includeSnapshots: z
          .boolean()
          .optional()
          .describe('Include snapshots and pre-releases. Off by default.'),
        limit: z.number().int().min(1).max(100).optional(),
      },
      outputSchema: {
        versions: z.array(
          z.object({
            version: z.string(),
            versionType: z.string(),
            loaders: z.array(z.string()),
          })
        ),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ includeSnapshots, limit }) => {
      const index = await getVersionIndex(ctx.db);
      const entries = (includeSnapshots === true ? [...index.toJSON()] : index.releases()).slice(
        0,
        limit ?? 25
      );

      const versions = entries.map((entry) => ({
        version: entry.version,
        versionType: entry.versionType,
        loaders: availableLoaders(entry.version, index),
      }));

      const text = versions
        .map((v) => `• ${v.version} — ${v.loaders.map((l) => LOADER_LABELS[l]).join(', ')}`)
        .join('\n');
      return result(text || 'No versions available.', { versions });
    }
  );

  server.registerTool(
    'create_server',
    {
      title: 'Create a server',
      description:
        'Create a new Minecraft server. Always asks the human to confirm, because creating a ' +
        "server means accepting Mojang's EULA on their behalf, which only they can do. Check " +
        'list_minecraft_versions first so the loader you pick has builds for the version.',
      inputSchema: {
        name: z.string().min(1).max(64).describe('Display name. A slug is derived from it.'),
        loader: z.enum(LOADERS as [MinecraftLoader, ...MinecraftLoader[]]),
        gameVersion: z.string().describe('Minecraft version, e.g. "1.21.4" or "26.2"'),
        loaderVersion: z
          .string()
          .optional()
          .describe("Pin the loader's own build. Omit for the newest."),
        memoryMiB: z.number().int().min(512).max(262_144).optional(),
        cpus: z.number().min(0.5).max(64).optional(),
        motd: z.string().max(128).optional(),
      },
      outputSchema: {
        created: z.boolean(),
        reason: z.string().optional(),
        serverId: z.string().optional(),
        name: z.string().optional(),
        image: z.string().optional(),
        port: z.number().optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ name, loader, gameVersion, loaderVersion, memoryMiB, cpus, motd }) => {
      // Checked before the dialog, so the human is never asked to approve something that cannot
      // work. `createServer` re-checks — this is the courtesy, not the guard.
      const index = await getVersionIndex(ctx.db);
      const loaders = availableLoaders(gameVersion, index);
      if (!loaders.includes(loader)) {
        return toolError(
          `${LOADER_LABELS[loader]} has no builds for Minecraft ${gameVersion}.`,
          `Available for ${gameVersion}: ${loaders.map((l) => LOADER_LABELS[l]).join(', ')}.`
        );
      }

      const image = selectImage(loader, gameVersion, ctx.env.PLATTER_MINECRAFT_IMAGE_REPO);
      const memory = memoryMiB ?? 4096;

      const decision = await proposeAndConfirm({
        ctx,
        server,
        kind: 'create_server',
        title: `Create ${name} (${LOADER_LABELS[loader]} ${gameVersion})`,
        payload: { name, loader, gameVersion, loaderVersion, memoryMiB: memory, cpus: cpus ?? 2 },
        question: `Create "${name}" running ${LOADER_LABELS[loader]} ${gameVersion}?`,
        details: [
          `This accepts Mojang's EULA (https://aka.ms/MinecraftEULA) for this server. Only you can do that.`,
          `Image: ${image.image} — ${image.reason}`,
          `Resources: ${memory} MiB memory, ${cpus ?? 2} CPUs.`,
          "A port will be allocated from Platter's configured range.",
        ],
      });

      if (!decision.approved) {
        return result(decision.message, { created: false, reason: decision.reason });
      }

      const created = await createServer(ctx, {
        name,
        loader,
        gameVersion,
        ...(loaderVersion === undefined ? {} : { loaderVersion }),
        ...(motd === undefined ? {} : { settings: { motd } }),
        resources: { memoryMiB: memory, ...(cpus === undefined ? {} : { cpus }) },
        // The human's approval above is the acceptance. There is no separate flag for a model
        // to set, because there is nothing a model could honestly set it from.
        acceptEula: true,
        actor: 'ai',
      });

      recordOutcome(ctx, decision.proposalId, {
        ok: !isErr(created),
        ...(isErr(created)
          ? { message: created.error.message }
          : { serverId: created.value.id, result: { name: created.value.name } }),
      });

      if (isErr(created)) {
        return toolError(created.error.message);
      }

      const value = created.value;
      return result(
        `Created ${value.name} (${LOADER_LABELS[loader]} ${gameVersion}) on port ${value.port}. ` +
          'It is not running yet — use control_server to start it.',
        {
          created: true,
          serverId: value.id,
          name: value.name,
          image: value.image,
          port: value.port,
        }
      );
    }
  );
}
