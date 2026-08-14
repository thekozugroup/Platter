import type { AuditLog } from '@prisma/client';
import type { FastifyBaseLogger, FastifyRequest } from 'fastify';
import { AUDIT_ACTIONS, type AuditAction, type AuditEntry } from '@platter/shared';
import { prisma } from '../db.js';
import { newId } from '../lib/ids.js';

export type AuditTargetType = AuditEntry['targetType'];

export interface AuditInput {
  action: AuditAction;
  targetType: AuditTargetType;
  /** Null for system-initiated actions: a schedule firing has no human behind it. */
  actorId?: string | null;
  /** Captured at write time so the entry still names the actor after the account is gone. */
  actorName?: string | null;
  targetId?: string | null;
  targetName?: string | null;
  metadata?: Record<string, unknown>;
  ip?: string | null;
  userAgent?: string | null;
  /** Where a failed write is reported. Falls back to stderr when the caller has no logger. */
  logger?: FastifyBaseLogger;
}

/** Long values are clipped rather than rejected — an audit row is evidence, not a document. */
const MAX_METADATA_BYTES = 8 * 1024;
const MAX_USER_AGENT_LENGTH = 400;

function serialiseMetadata(metadata: Record<string, unknown> | undefined): string {
  if (!metadata) return '{}';
  try {
    const json = JSON.stringify(metadata);
    if (json === undefined) return '{}';
    return json.length > MAX_METADATA_BYTES
      ? JSON.stringify({ truncated: true, bytes: json.length })
      : json;
  } catch {
    // Circular or otherwise unserialisable context. Losing it must not lose the entry.
    return JSON.stringify({ unserializable: true });
  }
}

/**
 * Writes one audit row.
 *
 * Never throws. An audit failure must not turn a successful action into a 500 — the user
 * really did delete that server, and telling them otherwise would be a lie that provokes a
 * destructive retry. A dropped entry is logged loudly instead, where it is a monitoring
 * problem rather than a correctness one.
 */
export async function recordAudit(input: AuditInput): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        id: newId('aud'),
        action: input.action,
        actorId: input.actorId ?? null,
        actorName: input.actorName ?? null,
        targetType: input.targetType,
        targetId: input.targetId ?? null,
        targetName: input.targetName ?? null,
        metadata: serialiseMetadata(input.metadata),
        ip: input.ip ?? null,
        userAgent: input.userAgent?.slice(0, MAX_USER_AGENT_LENGTH) ?? null,
      },
    });
  } catch (error) {
    const message = 'failed to write audit entry';
    if (input.logger) input.logger.error({ err: error, action: input.action }, message);
    else process.stderr.write(`${message}: ${String(error)}\n`);
  }
}

/**
 * The form routes should use: actor, address and user agent all come from the request, so
 * a handler cannot accidentally attribute an action to the wrong principal.
 */
export async function recordAuditFromRequest(
  request: FastifyRequest,
  input: Omit<AuditInput, 'actorId' | 'actorName' | 'ip' | 'userAgent' | 'logger'> &
    Partial<Pick<AuditInput, 'actorId' | 'actorName'>>,
): Promise<void> {
  const actor = request.auth?.user ?? null;
  await recordAudit({
    ...input,
    actorId: input.actorId ?? actor?.id ?? null,
    actorName: input.actorName ?? actor?.displayName ?? null,
    ip: request.ip,
    userAgent: request.headers['user-agent'] ?? null,
    logger: request.log,
  });
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

function parseMetadata(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

const TARGET_TYPES: readonly string[] = [
  'server',
  'user',
  'node',
  'backup',
  'schedule',
  'apikey',
  'system',
];

function isAuditAction(value: string): value is AuditAction {
  return (AUDIT_ACTIONS as readonly string[]).includes(value);
}

/**
 * Maps a stored row onto the wire shape, or null if the row cannot be represented.
 *
 * The action vocabulary is a closed enum on the wire, so a row written by a newer build
 * has no honest rendering here. Returning null and letting the caller skip it is better
 * than relabelling it as something it is not — a wrong entry in an audit log is worse
 * than a missing one.
 */
export function toAuditEntry(row: AuditLog): AuditEntry | null {
  if (!isAuditAction(row.action)) return null;
  return {
    id: row.id,
    action: row.action,
    actorId: row.actorId,
    actorName: row.actorName,
    targetType: TARGET_TYPES.includes(row.targetType)
      ? (row.targetType as AuditTargetType)
      : 'system',
    targetId: row.targetId,
    targetName: row.targetName,
    metadata: parseMetadata(row.metadata),
    ip: row.ip,
    userAgent: row.userAgent,
    createdAt: row.createdAt.toISOString(),
  };
}

/** The list form: rows this build cannot render are dropped rather than failing the page. */
export function toAuditEntries(rows: readonly AuditLog[]): AuditEntry[] {
  const entries: AuditEntry[] = [];
  for (const row of rows) {
    const entry = toAuditEntry(row);
    if (entry) entries.push(entry);
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** `{target}` is replaced with the target's name, falling back to its id. */
const AUDIT_PHRASES: Record<AuditAction, string> = {
  'auth.login': 'signed in',
  'auth.login_failed': 'failed to sign in',
  'auth.logout': 'signed out',
  'auth.password_changed': 'changed their password',
  'auth.totp_enabled': 'turned on two-factor authentication',
  'auth.totp_disabled': 'turned off two-factor authentication',
  'apikey.created': 'created the API key {target}',
  'apikey.revoked': 'revoked the API key {target}',
  'user.created': 'created the account {target}',
  'user.updated': 'updated the account {target}',
  'user.deleted': 'deleted the account {target}',
  'user.suspended': 'suspended the account {target}',
  'server.created': 'created the server {target}',
  'server.updated': 'updated the server {target}',
  'server.deleted': 'deleted the server {target}',
  'server.reinstalled': 'reinstalled the server {target}',
  'server.suspended': 'suspended the server {target}',
  'server.power': 'sent a power action to {target}',
  'server.command': 'ran a console command on {target}',
  'server.subuser_added': 'gave someone access to {target}',
  'server.subuser_updated': 'changed permissions on {target}',
  'server.subuser_removed': 'removed someone from {target}',
  'file.written': 'edited a file on {target}',
  'file.deleted': 'deleted files on {target}',
  'file.renamed': 'renamed a file on {target}',
  'file.uploaded': 'uploaded files to {target}',
  'backup.created': 'created the backup {target}',
  'backup.restored': 'restored the backup {target}',
  'backup.deleted': 'deleted the backup {target}',
  'schedule.created': 'created the schedule {target}',
  'schedule.updated': 'updated the schedule {target}',
  'schedule.deleted': 'deleted the schedule {target}',
  'schedule.executed': 'ran the schedule {target}',
  'node.created': 'added the node {target}',
  'node.updated': 'updated the node {target}',
  'node.deleted': 'removed the node {target}',
  'ai.provision_proposed': 'asked the assistant to design a server',
  'ai.fix_applied': 'applied an assistant suggestion to {target}',
  'settings.updated': 'changed Platter settings',
};

function stringMetadata(entry: AuditEntry, key: string): string | null {
  const value = entry.metadata[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * One sentence per entry for the activity feed. Kept next to the writer so a new action
 * cannot be added without deciding how a human reads it — the Record above is exhaustive
 * over `AuditAction`, so omitting one is a type error.
 */
export function describeAudit(entry: AuditEntry): string {
  const actor = entry.actorName ?? (entry.actorId === null ? 'Platter' : 'A deleted account');
  const target = entry.targetName ?? entry.targetId ?? 'it';

  let phrase = AUDIT_PHRASES[entry.action].replace('{target}', target);

  // A couple of actions are too coarse to read well without their context.
  if (entry.action === 'server.power') {
    const action = stringMetadata(entry, 'action');
    if (action) phrase = `sent ${action} to ${target}`;
  } else if (entry.action === 'file.written' || entry.action === 'file.renamed') {
    const path = stringMetadata(entry, 'path');
    if (path)
      phrase = `${entry.action === 'file.written' ? 'edited' : 'renamed'} ${path} on ${target}`;
  }

  return `${actor} ${phrase}.`;
}
