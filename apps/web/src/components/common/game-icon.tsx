import { hueFromString } from '@platter/shared';
import { cn } from '@/lib/utils';

/**
 * The game mark.
 *
 * Blueprints ship a two-letter monogram and a hue instead of artwork, so an air-gapped
 * install has no image assets to fetch and a new game needs no design work. Where the
 * blueprint is not loaded yet, the hue is derived from its key — deterministically, so the
 * icon never changes colour between two renders of the same server.
 *
 * Square with a small radius, never a circle: the whole system rests on rounded chrome
 * against square content, and a circular game mark reads as an avatar.
 */

export type GameIconSize = 'xs' | 'sm' | 'md' | 'lg';

/**
 * The pixel display face fills in and turns to mush below about 14px, so the two small
 * sizes set their monogram in bold sans and the two large ones get the display face.
 */
const SIZE_CLASS: Record<GameIconSize, string> = {
  xs: 'size-5 rounded-xs text-caption-2 font-sans font-semibold',
  sm: 'size-7 rounded-xs text-caption font-sans font-semibold',
  md: 'size-11 rounded-sm text-subhead font-heading font-medium',
  lg: 'size-16 rounded-md text-title-3 font-heading font-medium',
};

/** How many characters of the monogram fit without crowding the mark. */
const SIZE_CHARS: Record<GameIconSize, number> = { xs: 1, sm: 2, md: 3, lg: 3 };

export interface GameIconProps {
  /** From `blueprint.icon`. Falls back to initials derived from `name` or `blueprintKey`. */
  monogram?: string | undefined;
  /** From `blueprint.icon`. Falls back to a hash of `blueprintKey` or `name`. */
  hue?: number | undefined;
  blueprintKey?: string | undefined;
  /** A server or blueprint name, used for the fallback monogram. */
  name?: string | undefined;
  size?: GameIconSize;
  /**
   * Accessible name. Omit when the game or server name is already written next to the icon —
   * then it is decorative and stays out of the accessibility tree.
   */
  label?: string | undefined;
  className?: string | undefined;
}

/** `minecraft-java` -> `MJ`, `valheim` -> `VA`, `Survival SMP` -> `SS`. */
function deriveMonogram(name: string | undefined, blueprintKey: string | undefined): string {
  const source = (name ?? blueprintKey ?? '').trim();
  if (source.length === 0) return '??';

  const parts = source.split(/[\s\-_]+/).filter(Boolean);
  const first = parts[0] ?? source;
  if (parts.length > 1) {
    const second = parts[1] ?? '';
    return `${first.slice(0, 1)}${second.slice(0, 1)}`.toUpperCase();
  }
  return first.slice(0, 2).toUpperCase();
}

export function GameIcon({
  monogram,
  hue,
  blueprintKey,
  name,
  size = 'md',
  label,
  className,
}: GameIconProps) {
  const resolvedHue = hue ?? hueFromString(blueprintKey ?? name ?? 'platter');
  const resolvedMonogram = (monogram ?? deriveMonogram(name, blueprintKey)).slice(
    0,
    SIZE_CHARS[size],
  );

  return (
    <span
      className={cn(
        'inline-flex shrink-0 select-none items-center justify-center',
        'leading-none tracking-title text-white',
        SIZE_CLASS[size],
        className,
      )}
      style={{
        // Two stops of the same hue so a generated mark reads as artwork rather than a swatch.
        backgroundImage: `linear-gradient(160deg, hsl(${resolvedHue} 46% 48%), hsl(${resolvedHue} 44% 38%))`,
      }}
      {...(label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true })}
    >
      {resolvedMonogram}
    </span>
  );
}
