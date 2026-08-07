import {
  DEFAULT_JAVA_VERSION,
  JAVA_IMAGE_TAGS,
  LOADER_FAMILY,
  MINECRAFT_IMAGE,
  type MinecraftLoader,
  requiredJavaVersion,
} from '@platter/shared';

/**
 * How Platter turns "Paper 1.21.4, 4 GiB" into a container image tag.
 *
 * Every existing panel makes the user pick a Java version — Pterodactyl exposes a
 * `docker_images` map, PufferPanel has a `javaversion` variable defaulting to a hardcoded
 * number, Crafty offers a dropdown. All three then fail at boot with
 * `UnsupportedClassVersionError: class file version 65.0` when the user picks wrong, which is
 * the single most-asked support question across all of them.
 *
 * There is no reason a human should be in that loop. The Minecraft version determines the Java
 * floor, so Platter computes it and pins the tag.
 */

export interface ImageSelection {
  image: string;
  javaVersion: number;
  /** Why this tag was chosen — surfaced in the UI and to MCP clients. */
  reason: string;
}

/**
 * Forge below 1.18 is the one case where the floor is not enough: those builds use the old
 * ForgeGradle launcher and genuinely require Java 8, even though the Minecraft version itself
 * would run on 17. Getting this wrong produces a stack trace deep in `cpw.mods.modlauncher`
 * that looks nothing like a Java version problem.
 */
function javaForLoader(
  loader: MinecraftLoader,
  gameVersion: string,
  baseline: number
): { java: number; reason: string } {
  if (loader === 'forge' && baseline > 8) {
    const [major = 0, minor = 0] = gameVersion.split('.').map((n) => Number.parseInt(n, 10));
    if (major === 1 && minor < 18) {
      return {
        java: 8,
        reason: `Forge on Minecraft ${gameVersion} requires Java 8 — its launcher does not run on newer JVMs.`,
      };
    }
  }
  return {
    java: baseline,
    reason: `Minecraft ${gameVersion} requires Java ${baseline}.`,
  };
}

export function selectImage(loader: MinecraftLoader, gameVersion: string): ImageSelection {
  const baseline = requiredJavaVersion(gameVersion);
  const { java, reason } = javaForLoader(loader, gameVersion, baseline);
  const tag = JAVA_IMAGE_TAGS[java] ?? JAVA_IMAGE_TAGS[DEFAULT_JAVA_VERSION] ?? 'java21';
  return { image: `${MINECRAFT_IMAGE}:${tag}`, javaVersion: java, reason };
}

/* -------------------------------------------------------------------------- */
/* Loader → itzg TYPE                                                          */
/* -------------------------------------------------------------------------- */

/**
 * `TYPE` values accepted by the image's `case "${TYPE^^}"` dispatch. Platter exposes a curated
 * subset; the image supports many more (Magma, Mohist, Arclight, …) but those are hybrid
 * loaders with genuinely confusing compatibility stories, and shipping them without the
 * compatibility engine understanding them would be worse than not shipping them.
 */
export const LOADER_TYPE: Readonly<Record<MinecraftLoader, string>> = {
  vanilla: 'VANILLA',
  paper: 'PAPER',
  purpur: 'PURPUR',
  spigot: 'SPIGOT',
  folia: 'FOLIA',
  fabric: 'FABRIC',
  forge: 'FORGE',
  neoforge: 'NEOFORGE',
  quilt: 'QUILT',
};

/** Env var used to pin the loader's own build, per type. */
export const LOADER_VERSION_ENV: Readonly<Partial<Record<MinecraftLoader, string>>> = {
  fabric: 'FABRIC_LOADER_VERSION',
  forge: 'FORGE_VERSION',
  neoforge: 'NEOFORGE_VERSION',
  quilt: 'QUILT_LOADER_VERSION',
  paper: 'PAPER_BUILD',
  purpur: 'PURPUR_BUILD',
  folia: 'FOLIA_BUILD',
};

/** Directory inside /data that this loader's add-ons belong in. */
export function contentDirectory(loader: MinecraftLoader): 'mods' | 'plugins' | null {
  const family = LOADER_FAMILY[loader];
  if (family === 'mod') {
    return 'mods';
  }
  if (family === 'plugin') {
    return 'plugins';
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* Readiness and health                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Log line that means "the server is accepting players".
 *
 * Platter treats Docker's own healthcheck (`mc-health`, which server-list-pings the port) as
 * the authority, because it keeps working when logging is reconfigured by a mod. This pattern
 * is the *secondary* signal: it fires seconds earlier than the health check's 30s interval, so
 * the UI can flip to "running" without a visible lag.
 */
export const READY_PATTERN = /\bDone\s*\([0-9.]+s\)!\s*For help, type "help"/;

/**
 * Docker's healthcheck reports `healthy` for a paused server too — `mc-health` short-circuits
 * with exit 0 when autopause has SIGSTOPped the JVM. Anything that equates healthy with
 * "players can join" is wrong when autopause is enabled, which is why Platter tracks the
 * pause state separately rather than inferring it.
 */
export const AUTOPAUSE_SENTINEL = '/data/.paused';
