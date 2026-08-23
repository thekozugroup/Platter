/**
 * A pixel mark per game, drawn here rather than fetched or licensed.
 *
 * Two-letter monograms told you a tile existed; they did not tell you which game it was, and
 * a list of twelve reads as twelve swatches. These are original marks — a longship, a cog, a
 * crosshair — chosen to be recognisable at a glance without reproducing anyone's logo. That
 * is deliberate: real game logos are trademarks, and bundling them in an MIT repository would
 * hand every person who forks it a problem they did not ask for.
 *
 * Drawn as whole cells on a 24×24 grid, so they stay crisp at every size the icon renders and
 * match the pixel language of the rest of the interface. Being geometry rather than image
 * files, they need no network, survive an air-gapped install, and satisfy `img-src 'self'`
 * without an exception — the same properties the monogram had.
 *
 * A blueprint names a glyph; if the name is unknown the icon falls back to its monogram, so
 * adding a game never requires artwork before it can ship.
 */

/** `[x, y, width, height]` in grid cells. */
export type GlyphRect = readonly [number, number, number, number];

export const GAME_GLYPHS: Readonly<Record<string, readonly GlyphRect[]>> = {
  /** Pickaxe — the first thing you make, in every version of the game. */
  pickaxe: [
    [4, 6, 4, 2],
    [8, 4, 8, 2],
    [16, 6, 4, 2],
    [11, 8, 2, 12],
  ],
  /** Grass block: soil with a lighter cap, the Bedrock counterpart to the pickaxe. */
  block: [
    [3, 5, 18, 4],
    [3, 10, 18, 9],
  ],
  /** Longship under sail. */
  longship: [
    [3, 11, 2, 4],
    [3, 15, 18, 3],
    [6, 18, 12, 2],
    [11, 4, 2, 11],
    [13, 5, 6, 7],
  ],
  /** Paw print. */
  paw: [
    [3, 6, 3, 4],
    [8, 4, 3, 4],
    [13, 4, 3, 4],
    [18, 6, 3, 4],
    [6, 12, 12, 7],
  ],
  /** Hammer. */
  hammer: [
    [5, 4, 12, 5],
    [11, 9, 2, 11],
  ],
  /** Tree. */
  tree: [
    [8, 3, 8, 4],
    [5, 7, 14, 4],
    [7, 11, 10, 4],
    [11, 15, 2, 6],
  ],
  /** Cog, drawn as a ring so the centre stays open without needing a knocked-out fill. */
  cog: [
    [9, 2, 6, 3],
    [9, 19, 6, 3],
    [2, 9, 3, 6],
    [19, 9, 3, 6],
    [6, 6, 12, 3],
    [6, 15, 12, 3],
    [6, 9, 3, 6],
    [15, 9, 3, 6],
  ],
  /** Factory: a sawtooth roofline and a chimney. */
  factory: [
    [3, 12, 18, 8],
    [3, 9, 4, 3],
    [9, 9, 4, 3],
    [16, 4, 3, 8],
    [16, 1, 2, 2],
  ],
  /** Fog bank. */
  fog: [
    [7, 6, 9, 4],
    [4, 10, 16, 4],
    [6, 15, 12, 3],
  ],
  /** Skull — the eyes and teeth are the gaps, not shapes. */
  skull: [
    [5, 4, 14, 4],
    [5, 8, 3, 6],
    [16, 8, 3, 6],
    [11, 10, 2, 3],
    [7, 14, 10, 3],
    [8, 17, 2, 2],
    [11, 17, 2, 2],
    [14, 17, 2, 2],
  ],
  /** Crosshair. */
  crosshair: [
    [11, 2, 2, 7],
    [11, 15, 2, 7],
    [2, 11, 7, 2],
    [15, 11, 7, 2],
    [11, 11, 2, 2],
  ],
  /** Campfire. */
  campfire: [
    [10, 3, 4, 4],
    [9, 7, 6, 4],
    [8, 11, 8, 4],
    [3, 16, 18, 3],
    [5, 13, 3, 3],
    [16, 13, 3, 3],
  ],
};

export function glyphFor(name: string | null | undefined): readonly GlyphRect[] | null {
  if (name === null || name === undefined) return null;
  return GAME_GLYPHS[name] ?? null;
}
