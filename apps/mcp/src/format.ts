import type { Server } from '@platter/core';
import { LOADER_LABELS } from '@platter/shared';

/**
 * Formatting for model consumption.
 *
 * Every tool returns both a `structuredContent` object and a text block. The structured payload
 * is what a client should program against; the text is what actually ends up in most models'
 * context today, and it is worth writing well rather than dumping JSON.
 *
 * The guiding rule: say the thing that determines the next action. "Stopped — crashed 4 minutes
 * ago, exit 137" leads somewhere. `{"status":"crashed","lastExitCode":137}` makes the model do
 * the interpreting, and it often gets it wrong.
 */

export function describeServerLine(server: Server): string {
  const parts = [
    `${server.name} (${server.id})`,
    `${LOADER_LABELS[server.loader]} ${server.gameVersion}`,
    server.status,
    `port ${server.port}`,
    `${formatMiB(server.memoryMiB)} RAM`,
  ];
  if (server.statusMessage) {
    parts.push(server.statusMessage);
  }
  return parts.join(' · ');
}

export function formatMiB(mib: number): string {
  return mib >= 1024 ? `${(mib / 1024).toFixed(mib % 1024 === 0 ? 0 : 1)} GB` : `${mib} MB`;
}

export function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value < 10 && unit > 0 ? 1 : 0)} ${units[unit]}`;
}

export function formatAgo(epochMs: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - epochMs) / 1000));
  if (seconds < 60) {
    return `${seconds}s ago`;
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 48) {
    return `${hours}h ago`;
  }
  return `${Math.round(hours / 24)}d ago`;
}

/**
 * A tool result carrying both a readable summary and a machine-readable payload.
 *
 * The cast is deliberate. MCP types `structuredContent` as `Record<string, unknown>`, but every
 * useful payload here is a named interface, and TypeScript will not widen an interface to an
 * index signature. The alternative — declaring every payload inline as an anonymous object —
 * would cost the type safety that makes the interfaces worth having.
 */
export function result<T extends object>(text: string, structured: T) {
  return {
    content: [{ type: 'text' as const, text }],
    structuredContent: structured as unknown as Record<string, unknown>,
  };
}

/**
 * An error the model should be able to act on.
 *
 * `isError` matters: without it, a failure reads to the model as a successful call that happened
 * to return prose, and it carries on as though the change was applied.
 */
export function toolError(message: string, hint?: string) {
  return {
    content: [{ type: 'text' as const, text: hint ? `${message}\n\n${hint}` : message }],
    isError: true,
  };
}

/** Truncate a long block, keeping the end — the useful part of a log is the last part. */
export function tailText(text: string, maxChars = 12_000): string {
  if (text.length <= maxChars) {
    return text;
  }
  const kept = text.slice(-maxChars);
  const dropped = text.length - kept.length;
  return `… ${dropped.toLocaleString()} earlier characters omitted …\n${kept}`;
}
