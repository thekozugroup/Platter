/**
 * Legible initials on an avatar whose background is user data.
 *
 * Avatar colours are generated per account, so a fixed white monogram is a bet the component
 * cannot win: the generated palette runs through mid-tone magentas and greens where white
 * lands near 3:1, well under AA for 12px semibold initials. Worse, *neither* near-black nor
 * off-white clears 4.5:1 against a background whose luminance sits in the middle — the two
 * inks cross at 4.14:1 — so choosing the better ink alone is not enough.
 *
 * So this returns a pair: the ink that wins, and the background nudged the smallest distance
 * that makes it win by 4.5:1. The nudge is a straight blend toward white or black, which
 * leaves the hue — the part that identifies the account — where it was.
 */

/** The system's two inks. An avatar never gets a third, or a tint of its own background. */
const INK_DARK = '#111111';
const INK_LIGHT = '#f7f7f7';

/** The background luminance each ink needs to clear 4.5:1, solved from the WCAG formula. */
const MIN_LUMINANCE_FOR_DARK_INK = 0.201;
const MAX_LUMINANCE_FOR_LIGHT_INK = 0.167;
/** Where the two inks tie. Above it near-black wins, below it off-white does. */
const INK_CROSSOVER = 0.1834;

type Rgb = [number, number, number];

function channel(value: number): number {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function luminance([r, g, b]: Rgb): number {
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** Accepts `#rgb` and `#rrggbb`. Anything else returns null and the caller keeps its default. */
function parseHex(color: string): Rgb | null {
  const hex = color.trim().replace(/^#/, '');
  const full =
    hex.length === 3
      ? hex
          .split('')
          .map((c) => c + c)
          .join('')
      : hex;
  if (!/^[0-9a-f]{6}$/i.test(full)) return null;
  return [
    Number.parseInt(full.slice(0, 2), 16),
    Number.parseInt(full.slice(2, 4), 16),
    Number.parseInt(full.slice(4, 6), 16),
  ];
}

function toHex([r, g, b]: Rgb): string {
  return `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
}

/** `amount` of 0 keeps the colour, 1 reaches the target. Hue survives; luminance moves. */
function blend(rgb: Rgb, target: 0 | 255, amount: number): Rgb {
  return rgb.map((c) => c + (target - c) * amount) as Rgb;
}

export interface AvatarInk {
  /** The colour to paint behind the initials — the account's, adjusted only if it had to be. */
  background: string;
  ink: string;
}

export function avatarInk(color: string, fallback = '#333333'): AvatarInk {
  const rgb = parseHex(color) ?? parseHex(fallback);
  if (!rgb) return { background: fallback, ink: INK_LIGHT };

  const light = luminance(rgb) < INK_CROSSOVER;
  const target = light ? 0 : 255;
  const satisfied = (candidate: Rgb): boolean =>
    light
      ? luminance(candidate) <= MAX_LUMINANCE_FOR_LIGHT_INK
      : luminance(candidate) >= MIN_LUMINANCE_FOR_DARK_INK;

  let adjusted = rgb;
  if (!satisfied(rgb)) {
    // Ten steps resolves the blend to under 1% — finer than the eye, and the whole range
    // only ever spans the narrow band where the two inks are close to tying anyway.
    for (let step = 1; step <= 10; step += 1) {
      adjusted = blend(rgb, target, step / 10);
      if (satisfied(adjusted)) break;
    }
  }

  return { background: toHex(adjusted), ink: light ? INK_LIGHT : INK_DARK };
}

/** The same pair as an inline style, for the several places that render one directly. */
export function avatarStyle(color: string): { backgroundColor: string; color: string } {
  const { background, ink } = avatarInk(color);
  return { backgroundColor: background, color: ink };
}
