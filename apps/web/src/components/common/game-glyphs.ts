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
  /**
   * Pickaxe — the first thing you make, in every version of the game.
   *
   * The head is a stepped arc with the ends dropping below the centre, which is the only
   * thing separating it from `hammer`: drawn as a flat bar the two marks were the same
   * picture, and Minecraft and Terraria sat next to each other in the list wearing it.
   */
  pickaxe: [
    [3, 8, 3, 2],
    [6, 6, 4, 2],
    [10, 5, 4, 2],
    [14, 6, 4, 2],
    [18, 8, 3, 2],
    [11, 7, 2, 14],
  ],
  /**
   * Grass block, the Bedrock counterpart to the pickaxe.
   *
   * The fringe between cap and soil is what makes it a grass block rather than two stacked
   * bars — a single fill cannot carry the two tones the real block uses.
   */
  block: [
    [3, 4, 18, 4],
    [3, 8, 2, 2],
    [7, 8, 2, 2],
    [11, 8, 2, 2],
    [15, 8, 2, 2],
    [19, 8, 2, 2],
    [3, 10, 18, 9],
  ],
  /**
   * Longship under sail: square sail over a hull with both ends swept up.
   *
   * The sail is one shape rather than two halves split by the mast. Split, at 24 pixels it
   * read as an unrelated pair of blocks and the mark meant nothing.
   */
  longship: [
    [11, 2, 2, 2],
    [6, 4, 12, 8],
    [2, 12, 2, 4],
    [20, 12, 2, 4],
    [3, 15, 18, 3],
    [5, 18, 14, 2],
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
  /** Fog bank: offset bands, because centred ones stack into a single solid shape. */
  fog: [
    [6, 6, 11, 3],
    [9, 11, 11, 3],
    [4, 16, 12, 3],
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
  /**
   * Campfire: a flame over a log.
   *
   * The tip sits off centre. Drawn symmetrically the steps read as a pyramid rather than
   * something burning.
   */
  campfire: [
    [12, 2, 2, 3],
    [10, 5, 4, 3],
    [9, 8, 6, 4],
    [8, 12, 8, 3],
    [3, 17, 18, 3],
  ],
};

export function glyphFor(name: string | null | undefined): readonly GlyphRect[] | null {
  if (name === null || name === undefined) return null;
  return GAME_GLYPHS[name] ?? null;
}
