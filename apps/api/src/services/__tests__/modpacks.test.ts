import { describe, expect, it } from 'vitest';
import { detectModpack } from '../modpacks.js';

/**
 * Which pack a server runs, read from the variables the container image itself dispatches on.
 *
 * The cases that matter are the ones where a wrong answer puts the wrong picture on a
 * server: a pasted URL instead of a slug (which is what is in someone's address bar when
 * they choose a pack), and a variable left behind by a server type that has since changed.
 */

describe('detectModpack', () => {
  it('reads a Modrinth pack from its slug', () => {
    expect(detectModpack({ TYPE: 'MODRINTH', MODRINTH_MODPACK: 'cobblemon-fabric' })).toEqual({
      source: 'modrinth',
      ref: 'cobblemon-fabric',
    });
  });

  it('accepts the URL people actually paste', () => {
    expect(
      detectModpack({
        TYPE: 'MODRINTH',
        MODRINTH_MODPACK: 'https://modrinth.com/modpack/cobblemon-fabric',
      }),
    ).toEqual({ source: 'modrinth', ref: 'cobblemon-fabric' });
  });

  it('ignores query strings and trailing segments on that URL', () => {
    expect(
      detectModpack({
        TYPE: 'MODRINTH',
        MODRINTH_MODPACK: 'https://modrinth.com/modpack/fabulously-optimized/versions?g=1.21',
      }),
    ).toEqual({ source: 'modrinth', ref: 'fabulously-optimized' });
  });

  it('prefers an explicit CurseForge slug over the page URL', () => {
    expect(
      detectModpack({
        TYPE: 'AUTO_CURSEFORGE',
        CF_SLUG: 'all-the-mods-10',
        CF_PAGE_URL: 'https://www.curseforge.com/minecraft/modpacks/something-else',
      }),
    ).toEqual({ source: 'curseforge', ref: 'all-the-mods-10' });
  });

  it('falls back to the CurseForge page URL when only that is set', () => {
    expect(
      detectModpack({
        TYPE: 'AUTO_CURSEFORGE',
        CF_SLUG: '',
        CF_PAGE_URL: 'https://www.curseforge.com/minecraft/modpacks/all-the-mods-10',
      }),
    ).toEqual({ source: 'curseforge', ref: 'all-the-mods-10' });
  });

  it('takes an FTB pack by its numeric id', () => {
    expect(detectModpack({ TYPE: 'FTBA', FTB_MODPACK_ID: '126' })).toEqual({
      source: 'ftb',
      ref: '126',
    });
  });

  it('refuses a non-numeric FTB id rather than asking the API about it', () => {
    expect(detectModpack({ TYPE: 'FTBA', FTB_MODPACK_ID: 'direwolf20' })).toBeNull();
  });

  /**
   * The case that would put the wrong artwork on a server. Switching a server from a pack
   * to Paper leaves the pack variable behind — the image ignores it, and so must this.
   */
  it('ignores a pack variable left over from a type the server no longer runs', () => {
    expect(detectModpack({ TYPE: 'PAPER', MODRINTH_MODPACK: 'cobblemon-fabric' })).toBeNull();
    expect(detectModpack({ TYPE: 'FABRIC', CF_SLUG: 'all-the-mods-10' })).toBeNull();
  });

  it('is null for a pack type with nothing filled in yet', () => {
    expect(detectModpack({ TYPE: 'MODRINTH', MODRINTH_MODPACK: '   ' })).toBeNull();
    expect(detectModpack({ TYPE: 'AUTO_CURSEFORGE' })).toBeNull();
    expect(detectModpack({})).toBeNull();
  });

  it('is case-insensitive about the type, which operators type by hand', () => {
    expect(detectModpack({ TYPE: 'modrinth', MODRINTH_MODPACK: 'cobblemon-fabric' })).toEqual({
      source: 'modrinth',
      ref: 'cobblemon-fabric',
    });
  });
});
