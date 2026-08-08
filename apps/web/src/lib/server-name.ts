import { LIMITS } from '@platter/shared';

/**
 * The one rule for a server's name, mirroring `createServerRequestSchema` in
 * `@platter/shared` so the create wizard and the settings form agree.
 *
 * It exists because renaming is optimistic: the header, the sidebar and every card take the
 * new name the moment it is typed. That is only honest for a name the API will accept — an
 * empty one flashes a nameless server across the whole shell before the rollback lands, so
 * the check has to happen before the mutation, not after it.
 */
export function serverNameProblem(name: string): string | null {
  const trimmed = name.trim();
  if (trimmed.length < LIMITS.serverNameMin) return 'Give your server a name.';
  if (trimmed.length > LIMITS.serverNameMax) {
    return `Keep it to ${LIMITS.serverNameMax} characters or fewer.`;
  }
  return null;
}
