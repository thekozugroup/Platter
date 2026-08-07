import type { Fix, Match, MatchContext, Rule } from '../types';
import { candidateBlocks, detailNumber, match } from './helpers';

/**
 * Java version mismatches — the single most common way a Minecraft server fails to start.
 *
 * Every competing panel makes the user pick a Java version by hand and then fails at boot when
 * they pick wrong; it is the most-asked support question across all of them. Platter derives the
 * version from the Minecraft version at creation time, so these rules exist for the cases that
 * derivation cannot cover: a pinned image, an imported server, and — the nasty one — mods that
 * need an *older* JVM than the game itself does.
 *
 * That last case is why there are three rules rather than one. `UnsupportedClassVersionError`
 * only ever means "the JVM is too old". The two failures that mean "the JVM is too new" look
 * nothing like it and nothing like each other.
 */

/** itzg publishes an image tag per Java version. Recommending one it does not build helps nobody. */
export const AVAILABLE_JAVA_VERSIONS: readonly number[] = [8, 11, 17, 21, 25];

/**
 * Class file major version → Java version. 61 is Java 17, 65 is Java 21, 69 is Java 25.
 *
 * The offset has been a constant 44 since Java 1.1 and the JVM specification treats it as one,
 * so this is a formula rather than a table — a table would need editing every March and
 * September, and would be wrong in between.
 */
export function javaVersionForClassFile(classFileMajor: number): number | undefined {
  if (!Number.isInteger(classFileMajor) || classFileMajor < 45 || classFileMajor > 200) {
    return undefined;
  }
  return classFileMajor - 44;
}

/** The smallest published image that can run the required version. */
export function snapToAvailableJava(required: number): number {
  return AVAILABLE_JAVA_VERSIONS.find((v) => v >= required) ?? AVAILABLE_JAVA_VERSIONS[AVAILABLE_JAVA_VERSIONS.length - 1] ?? 21;
}

/* -------------------------------------------------------------------------- */
/* JVM too old                                                                 */
/* -------------------------------------------------------------------------- */

const CLASS_VERSION_RE =
  /UnsupportedClassVersionError[\s\S]{0,400}?class file version (?<needed>\d{2,3})\.\d+[\s\S]{0,200}?up to (?<current>\d{2,3})\.\d+/;

/** The same error without the "recognizes up to" half, which some JVMs omit. */
const CLASS_VERSION_SHORT_RE = /UnsupportedClassVersionError[\s\S]{0,400}?class file version (?<needed>\d{2,3})\.\d+/;

export const javaTooOld: Rule = {
  id: 'java.version-too-old',
  title: 'This server needs a newer version of Java than the container provides',
  severity: 'critical',
  category: 'java',
  hints: ['unsupportedclassversionerror'],
  // A JVM that cannot even load the server jar produces a cascade of downstream noise.
  supersedes: ['mods.mixin-apply-failure', 'startup.generic-failure'],

  match(ctx: MatchContext): Match | null {
    for (const block of candidateBlocks(ctx.blocks)) {
      const full = CLASS_VERSION_RE.exec(block.text);
      if (full?.groups) {
        const needed = javaVersionForClassFile(Number(full.groups.needed));
        const current = javaVersionForClassFile(Number(full.groups.current));
        if (needed !== undefined) {
          return match([block], 'high', {
            neededJava: needed,
            ...(current === undefined ? {} : { currentJava: current }),
          });
        }
      }
      const short = CLASS_VERSION_SHORT_RE.exec(block.text);
      if (short?.groups) {
        const needed = javaVersionForClassFile(Number(short.groups.needed));
        if (needed !== undefined) {
          return match([block], 'medium', {
            neededJava: needed,
            ...(ctx.server.javaVersion === undefined ? {} : { currentJava: ctx.server.javaVersion }),
          });
        }
      }
    }
    return null;
  },

  explain(m: Match): string {
    const needed = detailNumber(m, 'neededJava', 21);
    const current = detailNumber(m, 'currentJava', 0);
    const running = current > 0 ? `Java ${current}` : 'an older version of Java';
    return (
      `The server software was built for Java ${needed}, but this container is running ` +
      `${running}. Java cannot run programs built for a newer version than itself, so it gave up ` +
      `before loading anything. This is a container setting, not a problem with your world, your ` +
      `mods or your settings — all of them are still intact.`
    );
  },

  fixes(m: Match): Fix[] {
    const needed = detailNumber(m, 'neededJava', 21);
    const target = snapToAvailableJava(needed);
    return [
      {
        id: `use-java-${target}`,
        title: `Switch the container to Java ${target}`,
        detail:
          `Restarts the server on the Java ${target} image. The server files, world and mods are ` +
          `on a separate volume and are not touched. Expect a one-off image download.`,
        kind: 'automatic',
        action: { type: 'change_java_version', java: target },
        confidence: 'high',
      },
    ];
  },
};

/* -------------------------------------------------------------------------- */
/* JVM too new for Forge's mixin layer                                         */
/* -------------------------------------------------------------------------- */

/**
 * `ClassMetadataNotFoundException` naming a core JDK class.
 *
 * The library that mods use to patch the game reads metadata for every class it touches. Newer
 * JDKs stopped exposing that metadata for their own classes in the way older Mixin releases
 * expect, so the failure surfaces as "I cannot find java.util.List" — a class that obviously
 * exists. itzg documents this exact signature as meaning "pin a Java 17 image", and mods as
 * recent as Minecraft 1.21 still hit it.
 */
const MIXIN_METADATA_RE =
  /org\.spongepowered\.asm\.mixin\.throwables\.ClassMetadataNotFoundException: (?<missing>[\w.$]+)/;

export const javaTooNewForMixin: Rule = {
  id: 'java.version-too-new-for-mods',
  title: 'A mod needs an older version of Java than the container provides',
  severity: 'critical',
  category: 'java',
  hints: ['classmetadatanotfoundexception'],
  supersedes: ['mods.mixin-apply-failure'],

  match(ctx: MatchContext): Match | null {
    // A container already on Java 17 or below cannot be suffering from a too-new JVM.
    if (ctx.server.javaVersion !== undefined && ctx.server.javaVersion <= 17) {
      return null;
    }
    for (const block of candidateBlocks(ctx.blocks)) {
      const found = MIXIN_METADATA_RE.exec(block.text);
      if (found?.groups) {
        const missing = found.groups.missing ?? '';
        // A missing *JDK* class is the tell. A missing game or mod class is an ordinary mod bug
        // that changing the JVM will not fix, so it gets reported with far less certainty.
        const isJdkClass = missing.startsWith('java.') || missing.startsWith('javax.');
        return match([block], isJdkClass ? 'high' : 'low', { missingClass: missing });
      }
    }
    return null;
  },

  explain(m: Match): string {
    const current = detailNumber(m, 'currentJava', 0);
    const running = current > 0 ? `Java ${current}` : 'a recent version of Java';
    return (
      `One of your mods uses a patching library that cannot read ${running}. It failed looking ` +
      `for a standard Java class that is definitely present, which is the signature of this ` +
      `mismatch rather than of a missing file. Mods for Minecraft 1.21 and earlier commonly need ` +
      `Java 17 even when the game itself would run on something newer.`
    );
  },

  fixes(): Fix[] {
    return [
      {
        id: 'use-java-17',
        title: 'Switch the container to Java 17',
        detail:
          'Restarts the server on the Java 17 image, which is the version this generation of mods ' +
          'was built and tested against. Your world and mods are not touched.',
        kind: 'automatic',
        action: { type: 'change_java_version', java: 17 },
        confidence: 'high',
      },
    ];
  },
};

/* -------------------------------------------------------------------------- */
/* JVM too new for pre-1.18 Forge                                              */
/* -------------------------------------------------------------------------- */

/**
 * Forge before Minecraft 1.18 assumes the JVM's application class loader is a `URLClassLoader`.
 * Java 9 replaced it with an internal type, so the cast fails instantly on any modern JVM. itzg
 * documents this line verbatim as meaning "you need Java 8".
 */
const APP_CLASSLOADER_RE =
  /class jdk\.internal\.loader\.ClassLoaders\$AppClassLoader cannot be cast to class java\.net\.URLClassLoader/;

export const javaTooNewForLegacyForge: Rule = {
  id: 'java.version-too-new-for-forge',
  title: 'This version of Forge needs Java 8',
  severity: 'critical',
  category: 'java',
  hints: ['appclassloader cannot be cast'],
  supersedes: ['mods.mixin-apply-failure', 'startup.generic-failure'],

  match(ctx: MatchContext): Match | null {
    for (const block of candidateBlocks(ctx.blocks)) {
      if (APP_CLASSLOADER_RE.test(block.text)) {
        return match([block], 'high', {
          ...(ctx.server.gameVersion === undefined ? {} : { gameVersion: ctx.server.gameVersion }),
        });
      }
    }
    return null;
  },

  explain(): string {
    return (
      'Forge builds for Minecraft 1.17 and earlier start up in a way that only works on Java 8. ' +
      'Every version of Java since 9 changed the internal detail they rely on, so the server ' +
      'stops within the first second, long before it looks at your mods. This is expected for ' +
      'older modpacks and is fixed entirely by running the right Java version.'
    );
  },

  fixes(): Fix[] {
    return [
      {
        id: 'use-java-8',
        title: 'Switch the container to Java 8',
        detail:
          'Restarts the server on the Java 8 image, which is what this era of Forge requires. ' +
          'Your world and mods are not touched.',
        kind: 'automatic',
        action: { type: 'change_java_version', java: 8 },
        confidence: 'high',
      },
    ];
  },
};
