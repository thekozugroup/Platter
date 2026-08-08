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
 * Square, never a circle and never rounded: the whole system rests on rounded chrome against
 * square content, so a game mark that borrows the chrome's radius erases the one contrast the
 * design is built on. A circular one reads as an avatar, which is a different object entirely.
 */

export type GameIconSize = 'xs' | 'sm' | 'md' | 'lg';

/**
 * The pixel display face fills in and turns to mush below about 14px, so the two small
 * sizes set their monogram in bold sans and the two large ones get the display face.
 */
const SIZE_CLASS: Record<GameIconSize, string> = {
  xs: 'size-5 rounded-none text-caption-2 font-sans font-semibold',
  sm: 'size-7 rounded-none text-caption font-sans font-semibold',
  md: 'size-11 rounded-none text-subhead font-heading font-medium',
  lg: 'size-16 rounded-none text-title-3 font-heading font-medium',
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

/**
 * The gradient's two lightness stops, and the floor the *lighter* one may not cross.
 *
 * Lightness in HSL is not perceptual: `hsl(220 46% 48%)` is a deep blue that carries white
 * comfortably, while `hsl(90 46% 48%)` is a bright lime where white measures 2.6:1 — and the
 * shipped Minecraft and Terraria marks were exactly that. Since a blueprint declares only a
 * hue, and the fallback hashes one out of a string, the failure is unbounded rather than a
 * few bad values someone could fix by hand.
 *
 * So the hue is honoured and the lightness is solved for: darkened, per hue, only as far as
 * white needs. Reds, blues and purples keep their declared 48%; the yellows and greens that
 * would have swallowed their monogram come down until they hold it.
 */
const STOP_LIGHT = 0.48;
const STOP_DARK = 0.38;
const SATURATION = 0.46;
/** Background luminance at which white reaches 4.5:1. */
const MAX_LUMINANCE = 0.1783;

function channel(value: number): number {
  return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

/** Relative luminance of an `hsl()` colour, without going through a string. */
function hslLuminance(hue: number, saturation: number, lightness: number): number {
  const chroma = saturation * Math.min(lightness, 1 - lightness);
  const component = (n: number): number => {
    const k = (n + hue / 30) % 12;
    return channel(lightness - chroma * Math.max(-1, Math.min(k - 3, 9 - k, 1)));
  };
  return 0.2126 * component(0) + 0.7152 * component(8) + 0.0722 * component(4);
}

/** The lighter stop for this hue, lowered in 1% steps only if white would not clear AA. */
function legibleLightness(hue: number): number {
  let lightness = STOP_LIGHT;
  while (lightness > 0.2 && hslLuminance(hue, SATURATION, lightness) > MAX_LUMINANCE) {
    lightness -= 0.01;
  }
  return lightness;
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
        backgroundImage: (() => {
          const top = legibleLightness(resolvedHue);
          const bottom = top - (STOP_LIGHT - STOP_DARK);
          return `linear-gradient(160deg, hsl(${resolvedHue} 46% ${(top * 100).toFixed(1)}%), hsl(${resolvedHue} 44% ${(bottom * 100).toFixed(1)}%))`;
        })(),
      }}
      {...(label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true })}
    >
      {resolvedMonogram}
    </span>
  );
}
