import type { Fix, Match, MatchContext, Rule } from '../types';
import { candidateBlocks, detailString, match } from './helpers';

/**
 * Configuration the server rejects before it starts.
 *
 * Both rules here fire from the image's bash entrypoint, not from Java, which is why they need
 * the `[init]` parsing to work at all — there is no stack trace and no log4j prefix, just a line
 * on stdout and an exit code. They are also the two failures a user is most likely to hit on
 * their very first launch, so the explanations assume no prior knowledge.
 */

/* -------------------------------------------------------------------------- */
/* EULA                                                                        */
/* -------------------------------------------------------------------------- */

/** The entrypoint's own refusal, emitted when `/data/eula.txt` is absent and `EULA` is not true. */
const ITZG_EULA_RE = /Please accept the Minecraft EULA/;

/**
 * Vanilla's refusal, emitted when `eula.txt` *does* exist and says `eula=false`.
 *
 * Both are needed. The image only checks the `EULA` variable when the file is missing, so a
 * server that once wrote `eula=false` to disk never trips the entrypoint check again and fails
 * a layer deeper with a completely different message.
 */
const VANILLA_EULA_RE = /You need to agree to the EULA in order to run the server/;

export const eulaNotAccepted: Rule = {
  id: 'config.eula-not-accepted',
  title: 'The Minecraft licence agreement has not been accepted',
  severity: 'critical',
  category: 'config',
  hints: ['minecraft eula', 'agree to the eula'],

  match(ctx: MatchContext): Match | null {
    for (const block of candidateBlocks(ctx.blocks)) {
      if (ITZG_EULA_RE.test(block.text)) {
        return match([block], 'high', { source: 'entrypoint' });
      }
      if (VANILLA_EULA_RE.test(block.text)) {
        return match([block], 'high', { source: 'eula-file' });
      }
    }
    return null;
  },

  explain(m: Match): string {
    const stale = detailString(m, 'source') === 'eula-file';
    return stale
      ? 'Mojang requires every server owner to accept the Minecraft End User Licence Agreement. ' +
          'A previous run saved a "not accepted" answer to disk, and the server will keep ' +
          'refusing to start until that is changed. Nothing is wrong with your world or your mods.'
      : 'Mojang requires every server owner to accept the Minecraft End User Licence Agreement ' +
          'before a server will run. That has not happened yet, so the server stopped before it ' +
          'started. Nothing is wrong with your world or your mods.';
  },

  fixes(): Fix[] {
    return [
      {
        id: 'accept-eula',
        title: 'Accept the Minecraft licence agreement',
        detail:
          'Records your acceptance and starts the server. By accepting you agree to the terms at ' +
          'https://aka.ms/MinecraftEULA — read them first if you have not.',
        kind: 'automatic',
        action: { type: 'accept_eula' },
        confidence: 'high',
      },
    ];
  },
};

/* -------------------------------------------------------------------------- */
/* Invalid server type                                                         */
/* -------------------------------------------------------------------------- */

const INVALID_TYPE_RE = /Invalid (?<var>TYPE|MODPACK_PLATFORM): '(?<value>[^']*)'/;

/**
 * The server flavours the image's `case "${TYPE^^}"` dispatch actually accepts.
 *
 * Taken from the dispatch rather than from the error message the image prints, which is
 * hand-maintained upstream and omits several types that do work. Used only to suggest a
 * correction, so being generous here costs nothing.
 */
const KNOWN_TYPES = [
  'VANILLA',
  'PAPER',
  'PURPUR',
  'SPIGOT',
  'BUKKIT',
  'CRAFTBUKKIT',
  'FOLIA',
  'PUFFERFISH',
  'LEAF',
  'FABRIC',
  'FORGE',
  'NEOFORGE',
  'QUILT',
  'SPONGEVANILLA',
  'MAGMA',
  'MOHIST',
  'ARCLIGHT',
  'CRUCIBLE',
  'KETTING',
  'BANNER',
  'LIMBO',
  'NANOLIMBO',
  'CUSTOM',
  'MODRINTH',
  'CURSEFORGE',
  'AUTO_CURSEFORGE',
  'FTBA',
  'GTNH',
] as const;

/** Nearest accepted value by containment — `PAPERMC` → `PAPER`, `NEO_FORGE` → `NEOFORGE`. */
function suggestType(value: string): string | undefined {
  const normalised = value.toUpperCase().replace(/[^A-Z]/g, '');
  if (normalised === '') {
    return undefined;
  }
  const exact = KNOWN_TYPES.find((t) => t.replace(/[^A-Z]/g, '') === normalised);
  if (exact !== undefined) {
    return exact;
  }
  return KNOWN_TYPES.find((t) => {
    const bare = t.replace(/[^A-Z]/g, '');
    return bare.includes(normalised) || normalised.includes(bare);
  });
}

export const invalidServerType: Rule = {
  id: 'config.invalid-server-type',
  title: 'The server flavour is not one the image recognises',
  severity: 'critical',
  category: 'config',
  hints: ['invalid type:', 'invalid modpack_platform:'],

  match(ctx: MatchContext): Match | null {
    for (const block of candidateBlocks(ctx.blocks)) {
      const found = INVALID_TYPE_RE.exec(block.text);
      if (found?.groups) {
        const value = found.groups.value ?? '';
        const suggestion = suggestType(value);
        return match([block], 'high', {
          variable: found.groups.var ?? 'TYPE',
          value,
          ...(suggestion === undefined ? {} : { suggestion }),
        });
      }
    }
    return null;
  },

  explain(m: Match): string {
    const value = detailString(m, 'value');
    const variable = detailString(m, 'variable', 'TYPE');
    const suggestion = detailString(m, 'suggestion');
    const base =
      `The server was asked to run as "${value}", which is not a server flavour this image ` +
      `knows how to install, so it stopped straight away.`;
    return suggestion === ''
      ? `${base} Pick one of the supported flavours — Vanilla, Paper, Fabric, Forge and NeoForge ` +
          `are the common ones.`
      : `${base} "${suggestion}" looks like what was meant (the ${variable} setting is spelled ` +
          `exactly, and is case-insensitive but not forgiving of extra words).`;
  },

  fixes(m: Match): Fix[] {
    const variable = detailString(m, 'variable', 'TYPE');
    const suggestion = detailString(m, 'suggestion');
    if (suggestion === '') {
      return [
        {
          id: 'pick-server-type',
          title: 'Choose a supported server flavour',
          detail:
            'Vanilla is the unmodified game. Paper runs plugins and is faster. Fabric, Forge and ' +
            'NeoForge run mods. Pick the one your content was built for.',
          kind: 'manual',
          confidence: 'high',
        },
      ];
    }
    return [
      {
        id: `set-type-${suggestion.toLowerCase()}`,
        title: `Set the server flavour to ${suggestion}`,
        detail: `Changes ${variable} to "${suggestion}" and restarts. Your world is untouched.`,
        kind: 'automatic',
        action: { type: 'set_setting', key: variable, value: suggestion },
        confidence: 'medium',
      },
    ];
  },
};
