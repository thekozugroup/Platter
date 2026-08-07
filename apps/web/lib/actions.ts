'use server';

import {
  createBackup,
  createServer,
  deleteBackup,
  deleteServer,
  ensureDefaultSchedules,
  getServer,
  recreateContainer,
  restartServer,
  restoreBackup,
  sendCommand,
  startServer,
  stopServer,
  updateSettings,
} from '@platter/core';
import {
  MINECRAFT_LOADERS,
  type Result,
  isErr,
  minecraftLoaderSchema,
  serverSettingsSchema,
} from '@platter/shared';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { getContext } from './server';

/**
 * Server actions.
 *
 * Every action follows the same shape: validate with Zod, call into `@platter/core`, translate a
 * `Result` into an `ActionState`, revalidate. Nothing here contains business logic — that all
 * lives in core, so the MCP server and the UI cannot drift apart in what they allow.
 *
 * Errors are returned rather than thrown. A failed action should re-render the form with the
 * reason next to the field, not replace the page with an error boundary.
 */

export interface ActionState {
  ok: boolean;
  message?: string;
  /** Machine-readable code, so the UI can special-case things like port exhaustion. */
  code?: string;
  fieldErrors?: Record<string, string>;
}

const OK: ActionState = { ok: true };

function toState(result: Result<unknown>): ActionState {
  if (isErr(result)) {
    return { ok: false, message: result.error.message, code: result.error.code };
  }
  return OK;
}

/* -------------------------------------------------------------------------- */
/* Creation                                                                    */
/* -------------------------------------------------------------------------- */

const createSchema = z.object({
  name: z.string().trim().min(1, 'Give your server a name.').max(64),
  loader: minecraftLoaderSchema,
  gameVersion: z.string().min(1, 'Pick a Minecraft version.').max(64),
  memoryMiB: z.coerce.number().int().min(1024).max(65_536),
  cpus: z.coerce.number().min(0.5).max(32),
  maxPlayers: z.coerce.number().int().min(1).max(200),
  motd: z.string().max(128).optional(),
  difficulty: z.enum(['peaceful', 'easy', 'normal', 'hard']),
  gameMode: z.enum(['survival', 'creative', 'adventure', 'spectator']),
  levelSeed: z.string().max(128).optional(),
  // An HTML checkbox posts nothing when unchecked, so `z.coerce.boolean()` would read "off" as
  // undefined and then fall through to a default of true. Model presence explicitly instead.
  onlineMode: z
    .union([z.literal('on'), z.literal(''), z.undefined()])
    .transform((value) => value === 'on'),
  acceptEula: z.literal('on', { message: 'You must accept the Minecraft EULA to continue.' }),
});

export async function createServerAction(
  _previous: ActionState,
  formData: FormData
): Promise<ActionState> {
  const parsed = createSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const key = issue.path[0];
      if (typeof key === 'string' && !fieldErrors[key]) {
        fieldErrors[key] = issue.message;
      }
    }
    return { ok: false, message: 'Check the highlighted fields.', fieldErrors };
  }

  const input = parsed.data;
  const ctx = await getContext();

  const result = await createServer(ctx, {
    name: input.name,
    loader: input.loader,
    gameVersion: input.gameVersion,
    acceptEula: true,
    resources: { memoryMiB: input.memoryMiB, cpus: input.cpus },
    settings: serverSettingsSchema.partial().parse({
      maxPlayers: input.maxPlayers,
      motd: input.motd || `A ${input.name} server`,
      difficulty: input.difficulty,
      gameMode: input.gameMode,
      onlineMode: input.onlineMode,
      ...(input.levelSeed ? { levelSeed: input.levelSeed } : {}),
    }),
  });

  if (isErr(result)) {
    return { ok: false, message: result.error.message, code: result.error.code };
  }

  ensureDefaultSchedules(ctx, result.value.id);

  // Start immediately: nobody creates a server in order to leave it stopped.
  await startServer(ctx, result.value.id);

  revalidatePath('/', 'layout');
  redirect(`/servers/${result.value.id}`);
}

/* -------------------------------------------------------------------------- */
/* Lifecycle                                                                   */
/* -------------------------------------------------------------------------- */

export async function startServerAction(serverId: string): Promise<ActionState> {
  const ctx = await getContext();
  const result = await startServer(ctx, serverId);
  revalidatePath('/', 'layout');
  return toState(result);
}

export async function stopServerAction(serverId: string): Promise<ActionState> {
  const ctx = await getContext();
  const result = await stopServer(ctx, serverId);
  revalidatePath('/', 'layout');
  return toState(result);
}

export async function restartServerAction(serverId: string): Promise<ActionState> {
  const ctx = await getContext();
  const result = await restartServer(ctx, serverId);
  revalidatePath('/', 'layout');
  return toState(result);
}

export async function deleteServerAction(
  serverId: string,
  purgeData: boolean
): Promise<ActionState> {
  const ctx = await getContext();
  const result = await deleteServer(ctx, serverId, { purgeData });
  if (isErr(result)) {
    return toState(result);
  }
  revalidatePath('/', 'layout');
  redirect('/');
}

/* -------------------------------------------------------------------------- */
/* Console                                                                     */
/* -------------------------------------------------------------------------- */

export async function sendCommandAction(
  serverId: string,
  command: string
): Promise<ActionState & { response?: string; channel?: 'rcon' | 'stdin' }> {
  const trimmed = command.trim();
  if (trimmed.length === 0) {
    return { ok: false, message: 'Type a command first.' };
  }
  const ctx = await getContext();
  const result = await sendCommand(ctx, serverId, trimmed);
  if (isErr(result)) {
    return { ok: false, message: result.error.message, code: result.error.code };
  }
  return { ok: true, response: result.value.response, channel: result.value.channel };
}

/* -------------------------------------------------------------------------- */
/* Settings                                                                    */
/* -------------------------------------------------------------------------- */

const settingsSchema = serverSettingsSchema.partial().extend({
  memoryMiB: z.coerce.number().int().min(1024).max(65_536).optional(),
  cpus: z.coerce.number().min(0.5).max(32).optional(),
});

export async function updateSettingsAction(
  serverId: string,
  _previous: ActionState,
  formData: FormData
): Promise<ActionState> {
  const raw = Object.fromEntries(formData);
  // HTML checkboxes are absent when unchecked, so booleans have to be reconstructed from the
  // set of keys the form declares rather than read directly.
  const declared = String(raw.__booleans ?? '')
    .split(',')
    .filter(Boolean);
  for (const key of declared) {
    raw[key] = raw[key] === 'on' ? 'true' : 'false';
  }
  delete raw.__booleans;

  const parsed = settingsSchema.safeParse(raw);
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const key = issue.path[0];
      if (typeof key === 'string' && !fieldErrors[key]) {
        fieldErrors[key] = issue.message;
      }
    }
    return { ok: false, message: 'Check the highlighted fields.', fieldErrors };
  }

  const { memoryMiB, cpus, ...settings } = parsed.data;
  const ctx = await getContext();

  const result = await updateSettings(ctx, serverId, settings);
  if (isErr(result)) {
    return toState(result);
  }

  // Resource limits live in the container spec, not in server.properties, so changing them
  // means rebuilding the container. The world directory is untouched.
  let restartRequired = result.value.restartRequired;
  if (memoryMiB !== undefined || cpus !== undefined) {
    const server = getServer(ctx.db, serverId);
    if (server) {
      const { updateServer } = await import('@platter/core');
      updateServer(ctx.db, serverId, {
        ...(memoryMiB === undefined ? {} : { memoryMiB }),
        ...(cpus === undefined ? {} : { cpus: Math.round(cpus * 1000) }),
      });
      const recreated = await recreateContainer(ctx, serverId);
      if (isErr(recreated)) {
        return toState(recreated);
      }
      restartRequired = false;
    }
  }

  revalidatePath('/', 'layout');
  return {
    ok: true,
    message: restartRequired
      ? 'Saved. Restart the server to apply the changes.'
      : 'Saved.',
  };
}

/** Rebuild the container so environment-mapped settings take effect. */
export async function applySettingsAction(serverId: string): Promise<ActionState> {
  const ctx = await getContext();
  const result = await recreateContainer(ctx, serverId);
  revalidatePath('/', 'layout');
  return toState(result);
}

/* -------------------------------------------------------------------------- */
/* Backups                                                                     */
/* -------------------------------------------------------------------------- */

export async function createBackupAction(
  serverId: string,
  label?: string
): Promise<ActionState> {
  const ctx = await getContext();
  const result = await createBackup(ctx, {
    serverId,
    ...(label ? { label } : {}),
    trigger: 'manual',
    actor: 'user',
  });
  revalidatePath(`/servers/${serverId}/backups`);
  return toState(result);
}

export async function restoreBackupAction(
  serverId: string,
  backupId: string
): Promise<ActionState> {
  const ctx = await getContext();
  const result = await restoreBackup(ctx, backupId, { actor: 'user' });
  revalidatePath('/', 'layout');
  return toState(result);
}

export async function deleteBackupAction(
  serverId: string,
  backupId: string
): Promise<ActionState> {
  const ctx = await getContext();
  const result = await deleteBackup(ctx, backupId);
  revalidatePath(`/servers/${serverId}/backups`);
  return toState(result);
}

export { MINECRAFT_LOADERS };
