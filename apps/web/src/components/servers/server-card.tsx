import { Link } from 'react-router';
import { formatMegabytes, type BlueprintSummary, type ServerSummary } from '@platter/shared';
import { GameIcon } from '@/components/common/game-icon';
import { StatusPill } from '@/components/common/status-pill';
import { cn } from '@/lib/utils';

/**
 * The server card — the most repeated object in the product, and the one that sets the tone.
 *
 * White, one hairline, 12px radius, **no shadow at rest**. Colour comes from the game mark
 * and the status dot; everything else is ink and four greys.
 *
 * Two implementation notes worth keeping:
 *
 * - **No frost.** A grid of these repeats, and `backdrop-filter` on a repeated element forces
 *   a compositing layer that repaints as the page scrolls behind it.
 * - **The hover lift animates opacity, not `box-shadow`.** Animating a shadow repaints every
 *   frame. The shadow lives on an `::after` pseudo-element that fades in, so the only animated
 *   properties are `opacity` and `translate`.
 */

export interface ServerCardProps {
  server: ServerSummary;
  /**
   * The matching entry from `GET /blueprints`. Supplies the real monogram, hue and game name;
   * without it the card falls back to a deterministic mark derived from the blueprint key.
   */
  blueprint?: BlueprintSummary | undefined;
  className?: string;
}

/** `Minecraft · Java Edition` — the game first, then which build of it is running. */
export function blueprintSubtitle(
  blueprintKey: string,
  blueprint?: BlueprintSummary | undefined,
): string {
  if (!blueprint) return blueprintKey;
  if (blueprint.name === blueprint.game) return blueprint.game;

  const edition = blueprint.name.startsWith(`${blueprint.game}: `)
    ? blueprint.name.slice(blueprint.game.length + 2)
    : blueprint.name;
  return `${blueprint.game} · ${edition}`;
}

/**
 * The card surface, shared with the list rows so a grid and a list of the same servers do not
 * drift into two different materials.
 */
export const cardSurface = cn(
  'relative rounded-md border border-separator-strong bg-surface',
  'after:pointer-events-none after:absolute after:inset-0 after:rounded-md',
  'after:shadow-3 after:opacity-0 after:transition-opacity after:duration-150 after:ease-standard',
);

/** Allocation and player count. Monospace, tabular, so it does not jitter as numbers tick. */
function cardDetail(server: ServerSummary): string {
  const parts = [formatMegabytes(server.memoryMb)];
  if (server.playersOnline !== null && server.playersMax !== null) {
    parts.push(`${server.playersOnline}/${server.playersMax} online`);
  }
  return parts.join(' · ');
}

export function ServerCard({ server, blueprint, className }: ServerCardProps) {
  const subtitle = blueprintSubtitle(server.blueprintKey, blueprint);
  const detail = cardDetail(server);
  const address = server.primaryAddress;

  return (
    <Link
      className={cn(
        'group block transition-[translate,opacity] duration-150 ease-standard',
        cardSurface,
        // Tailwind v4 gates `hover:` behind `@media (hover: hover)`, so touch devices never
        // get a lift that sticks after the tap.
        'hover:-translate-y-0.5 hover:after:opacity-100',
        'active:translate-y-0',
        'motion-reduce:translate-y-0! motion-reduce:transition-none!',
        className,
      )}
      to={`/servers/${server.id}`}
    >
      <div className="flex items-start gap-3 p-4">
        <GameIcon
          blueprintKey={server.blueprintKey}
          hue={blueprint?.icon.hue}
          monogram={blueprint?.icon.monogram}
          name={server.name}
          size="md"
        />

        <div className="min-w-0 flex-1">
          {/* font-sans on purpose: h3 inherits the pixel display face, which is unreadable here. */}
          <h3
            className="truncate font-sans text-body font-semibold tracking-title text-label"
            title={server.name}
          >
            {server.name}
          </h3>
          <p className="mt-0.5 truncate text-footnote text-label-secondary" title={subtitle}>
            {subtitle}
          </p>
        </div>

        <StatusPill className="mt-0.5" status={server.status} />
      </div>

      <div className="flex items-center justify-between gap-3 border-t border-separator px-4 py-3">
        <code
          className="min-w-0 flex-1 truncate font-mono text-caption text-label-secondary"
          title={address ?? undefined}
        >
          {address ?? 'Address assigned during install'}
        </code>
        <span className="tabular shrink-0 font-mono text-caption text-label-secondary">
          {detail}
        </span>
      </div>
    </Link>
  );
}

/**
 * The card's shape while the list loads. A skeleton rather than a spinner, because the shape
 * is known and the grid should not reflow when the data lands.
 */
export function ServerCardSkeleton({ className }: { className?: string }) {
  return (
    <div aria-hidden className={cn(cardSurface, className)}>
      <div className="flex items-start gap-3 p-4">
        <div className="skeleton size-11 rounded-sm" />
        <div className="flex min-w-0 flex-1 flex-col gap-2 pt-1">
          <div className="skeleton h-4 w-40 max-w-full rounded-xs" />
          <div className="skeleton h-3 w-28 max-w-full rounded-xs" />
        </div>
        <div className="skeleton h-6 w-20 rounded-pill" />
      </div>
      <div className="flex items-center justify-between gap-3 border-t border-separator px-4 py-3">
        <div className="skeleton h-3 w-44 max-w-full rounded-xs" />
        <div className="skeleton h-3 w-16 rounded-xs" />
      </div>
    </div>
  );
}
