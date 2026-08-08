import { formatDuration, formatRelativeTime, hueFromString } from '@platter/shared';
import {
  PlayerActions,
  type PlayerRecord,
  type PlayerTarget,
} from '@/components/players/player-actions';
import { cn } from '@/lib/utils';

/**
 * One player.
 *
 * The avatar is generated, never fetched. Platter is self-hosted and expected to run on a box
 * with no route to the internet, so calling out to a skin service would leave a grid of broken
 * squares on exactly the installs that care most — and would leak every player name on the
 * server to a third party. The colour is a hash of the name, so it is stable across reloads
 * and across machines without anything being stored.
 *
 * Layout is one component, not two: a card under 768px and a row above it, switched by flex
 * direction rather than by rendering both and hiding one. Two copies would put every action
 * into the accessibility tree twice.
 */

export interface PlayerAvatarProps {
  name: string;
  size?: 'sm' | 'md';
  className?: string;
}

const AVATAR_SIZE: Record<'sm' | 'md', string> = {
  sm: 'size-8 rounded-xs text-caption',
  md: 'size-10 rounded-sm text-subhead',
};

export function PlayerAvatar({ name, size = 'md', className }: PlayerAvatarProps) {
  const hue = hueFromString(name);
  // Minecraft names are one word, so `initials()` would give two letters of the same word;
  // a single leading character reads better at this size.
  const glyph = (name.trim()[0] ?? '?').toUpperCase();

  return (
    <span
      aria-hidden
      className={cn(
        'inline-flex shrink-0 select-none items-center justify-center',
        'font-semibold leading-none text-white',
        AVATAR_SIZE[size],
        className,
      )}
      style={{
        backgroundImage: `linear-gradient(160deg, hsl(${hue} 42% 46%), hsl(${hue} 40% 36%))`,
      }}
    >
      {glyph}
    </span>
  );
}

/** `Online for 2h 14m`, `Last seen 3 days ago`, or an honest blank. */
export function describePresence(player: PlayerRecord, now: number = Date.now()): string {
  if (player.online && player.onlineSince) {
    const since = Date.parse(player.onlineSince);
    if (Number.isFinite(since)) {
      return `Online for ${formatDuration(Math.max(0, (now - since) / 1000))}`;
    }
  }
  if (player.online) return 'Online now';
  if (player.lastSeen) return `Last seen ${formatRelativeTime(player.lastSeen)}`;
  return 'Never seen on this server';
}

/** `14h 20m played · 32 sessions`. */
export function describeHistory(player: PlayerRecord): string {
  const played =
    player.playtimeMs > 0
      ? `${formatDuration(player.playtimeMs / 1000)} played`
      : 'No playtime yet';
  const sessions =
    player.sessions === 1 ? '1 session' : `${player.sessions.toLocaleString()} sessions`;
  return `${played} · ${sessions}`;
}

interface BadgeSpec {
  label: string;
  tone: 'neutral' | 'danger';
}

function badgesFor(player: PlayerRecord): BadgeSpec[] {
  const badges: BadgeSpec[] = [];
  if (player.banned) badges.push({ label: 'Banned', tone: 'danger' });
  if (player.op) {
    badges.push({
      label: player.operatorLevel === null ? 'Operator' : `Operator ${player.operatorLevel}`,
      tone: 'neutral',
    });
  }
  if (player.whitelisted) badges.push({ label: 'Whitelisted', tone: 'neutral' });
  return badges;
}

export interface PlayerRowProps {
  serverId: string;
  serverName: string;
  player: PlayerRecord;
  /** Why nothing can be changed right now. Null when actions are available. */
  blockedReason: string | null;
  /** Under 768px the actions move into a sheet instead of a cramped row. */
  compact: boolean;
  now?: number;
  className?: string;
}

export function PlayerRow({
  serverId,
  serverName,
  player,
  blockedReason,
  compact,
  now = Date.now(),
  className,
}: PlayerRowProps) {
  const badges = badgesFor(player);
  const target: PlayerTarget = {
    name: player.name,
    online: player.online,
    op: player.op,
    whitelisted: player.whitelisted,
    banned: player.banned,
  };

  return (
    <li
      className={cn(
        'flex flex-col gap-4 py-4',
        'md:flex-row md:items-center md:justify-between md:gap-6',
        className,
      )}
    >
      <div className="flex min-w-0 items-center gap-3">
        <PlayerAvatar name={player.name} />

        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-2">
            <span className="truncate font-mono text-callout font-medium text-label">
              {player.name}
            </span>
            {/*
              A dot beside the name would be colour-only. The word travels with it, exactly
              like the server status pill.
            */}
            {player.online ? (
              <span className="inline-flex items-center gap-1.5 rounded-pill border border-pill-border bg-pill px-2 py-0.5 text-caption font-medium text-success">
                <span aria-hidden className="size-1.5 rounded-full bg-success-dot status-pulse" />
                Online
              </span>
            ) : null}
            {badges.map((badge) => (
              <span
                className={cn(
                  'rounded-pill border border-pill-border bg-pill px-2 py-0.5 text-caption font-medium',
                  badge.tone === 'danger' ? 'text-danger' : 'text-label-secondary',
                )}
                key={badge.label}
              >
                {badge.label}
              </span>
            ))}
          </p>

          <p className="mt-1 text-caption text-label-secondary tabular">
            {describePresence(player, now)} · {describeHistory(player)}
          </p>

          {player.banned && player.banReason ? (
            <p className="mt-1 text-caption text-label-tertiary">Ban reason: {player.banReason}</p>
          ) : null}
        </div>
      </div>

      <PlayerActions
        blockedReason={blockedReason}
        className="md:shrink-0"
        player={target}
        serverId={serverId}
        serverName={serverName}
        variant={compact ? 'sheet' : 'inline'}
      />
    </li>
  );
}
